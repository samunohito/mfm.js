import { emojiRegex } from '@misskey-dev/emoji-data';

import * as M from '..';
import * as P from './core';
import { mergeText } from './util';
import { SeqParseResult } from './core';

type ArgPair = { k: string, v: string | true };
type Args = Record<string, string | true>;

const space = P.regexp(/[\u0020\u3000\t]/);
const alphaAndNum = P.regexp(/[a-z0-9]/i);
const newLine = P.newline;

/**
 * Returns true if the UTF-16 code unit can never start an emoji match.
 * Emoji only start with `#`, `*` or a digit (keycaps), `©`, `®`, U+2000..U+2BFF, a few CJK symbols, surrogates or U+FE0F.
 * This assumption is checked against `emojiRegex` in test/core.ts.
 */
export function cannotStartEmoji(code: number): boolean {
	if (code < 0x2000) {
		return !(code === 0x23 || code === 0x2a || (code >= 0x30 && code <= 0x39) || code === 0xa9 || code === 0xae);
	}
	if (code < 0x2c00) {
		return false;
	}
	if (code < 0xd800) {
		return !(code === 0x3030 || code === 0x303d || code === 0x3297 || code === 0x3299);
	}
	if (code < 0xe000) {
		return false;
	}
	return !(code === 0xe50a || code === 0xfe0f);
}

/**
 * Returns true if an ASCII keycap base (`#`, `*` or a digit) followed by the code unit `next` cannot start an emoji match.
 * This assumption is checked against `emojiRegex` in test/core.ts.
 */
export function cannotStartKeycap(next: number): boolean {
	return next !== 0xfe0f && next !== 0x20e3;
}

const enum Ascii {
	// starts or closes a syntax
	Special = 0,
	// plain text in any context
	Plain = 1,
	// plain text unless a keycap follows
	Digit = 2,
	// plain text unless followed by `t` (`http`)
	H = 3,
	// plain text unless followed by `[`
	Question = 4,
}

const asciiKinds = new Uint8Array(0x80).fill(Ascii.Plain);
for (const c of '<*_`\\~$@#:[]\r\n') {
	asciiKinds[c.charCodeAt(0)] = Ascii.Special;
}
for (const c of '0123456789') {
	asciiKinds[c.charCodeAt(0)] = Ascii.Digit;
}
asciiKinds[0x68] = Ascii.H;
asciiKinds[0x3f] = Ascii.Question;

/**
 * Returns the end of the run of plain text starting at `index`.
 * A code unit is plain text in any context if it neither starts nor closes any syntax, and it cannot start an emoji.
 * Newlines are excluded since block syntax can start right after them.
 */
function plainTextEnd(input: string, index: number): number {
	let end = index;
	for (; end < input.length; end++) {
		const code = input.charCodeAt(end);
		if (code >= 0x80) {
			if (!cannotStartEmoji(code)) break;
			continue;
		}
		const kind = asciiKinds[code];
		if (kind === Ascii.Plain) continue;
		if (kind === Ascii.Special) break;
		const next = input.charCodeAt(end + 1);
		if (kind === Ascii.Digit ? !cannotStartKeycap(next) : kind === Ascii.H ? next === 0x74 : next === 0x5b) break;
	}
	return end;
}

function seqOrText<Parsers extends P.Parser<unknown>[]>(...parsers: Parsers): P.Parser<SeqParseResult<Parsers> | string> {
	return new P.Parser<SeqParseResult<Parsers> | string>((input, index, state) => {
		// TODO: typesafe implementation
		const accum: unknown[] = [];
		let latestIndex = index;
		for (let i = 0; i < parsers.length; i++) {
			const result = parsers[i].handler(input, latestIndex, state);
			if (!result.success) {
				if (latestIndex === index) {
					return P.failure();
				} else {
					return P.success(latestIndex, input.slice(index, latestIndex));
				}
			}
			accum.push(result.value);
			latestIndex = result.index;
		}
		return P.success(latestIndex, accum as SeqParseResult<Parsers>);
	});
}

const notLinkLabel = new P.Parser((_input, index, state) => {
	return (!state.linkLabel)
		? P.success(index, null)
		: P.failure();
});

// whether the character before the position is alphanumeric
function alphaAndNumBefore(input: string, index: number): boolean {
	return /[a-z0-9]/i.test(input.charAt(index - 1));
}

// instead of a regexp like /[.,]+$/, which takes quadratic time on a long run
function trailingLength(text: string, chars: string): number {
	let length = 0;
	while (length < text.length && chars.includes(text.charAt(text.length - 1 - length))) {
		length++;
	}
	return length;
}

// whether a nested syntax can be parsed at the current depth
function nestable(state: Parameters<P.ParserHandler<unknown>>[2]): boolean {
	// every attempt uses the budget, and nesting stops once it runs out, which bounds the time on crafted input
	if (state.nestBudget != null) {
		if (state.nestBudget <= 0) {
			return false;
		}
		state.nestBudget--;
	}
	return state.depth < state.nestLimit;
}

function nest<T>(parser: P.Parser<T>, fallback?: P.Parser<string>): P.Parser<T | string> {
	// nesting limited? -> No: specified parser, Yes: fallback parser (default = P.char)
	const fallbackParser = fallback ?? P.char;
	return new P.Parser<T | string>((input, index, state) => {
		state.depth++;
		let result: P.Result<T | string> = nestable(state) ? parser.handler(input, index, state) : P.failure();
		if (!result.success) {
			result = fallbackParser.handler(input, index, state);
		}
		state.depth--;
		return result;
	});
}

/**
 * Guards a block syntax that starts with at most `newLines` optional newlines followed by the char `mark`.
 */
function block<T>(newLines: number, mark: string, parser: P.Parser<T>): P.Parser<T> {
	const markCode = mark.charCodeAt(0);
	return new P.Parser<T>((input, index, state) => {
		let start = index;
		for (let i = 0; i < newLines; i++) {
			const code = input.charCodeAt(start);
			if (code === 0x0d) {
				start += (input.charCodeAt(start + 1) === 0x0a) ? 2 : 1;
			} else if (code === 0x0a) {
				start++;
			} else {
				break;
			}
		}
		if (input.charCodeAt(start) !== markCode) {
			return P.failure();
		}
		return parser.handler(input, index, state);
	});
}

interface TypeTable {
	fullParser: (M.MfmNode | string)[],
	simpleParser: (M.MfmSimpleNode | string)[],
	full: M.MfmNode | string,
	simple: M.MfmSimpleNode | string,
	inline: M.MfmInline | string,
	quote: M.NodeType<'quote'>,
	codeBlock: M.NodeType<'blockCode'>,
	mathBlock: M.NodeType<'mathBlock'>,
	centerTag: M.NodeType<'center'>,
	big: M.NodeType<'fn'> | string,
	boldAsta: M.NodeType<'bold'> | string,
	boldTag: M.NodeType<'bold'> | string,
	boldUnder: M.NodeType<'bold'>,
	smallTag: M.NodeType<'small'> | string,
	italicTag: M.NodeType<'italic'> | string,
	italicAsta: M.NodeType<'italic'>,
	italicUnder: M.NodeType<'italic'>,
	strikeTag: M.NodeType<'strike'> | string,
	strikeWave: M.NodeType<'strike'> | string,
	unicodeEmoji: M.NodeType<'unicodeEmoji'> | string,
	plainTag: M.NodeType<'plain'>,
	fn: M.NodeType<'fn'> | string,
	inlineCode: M.NodeType<'inlineCode'>,
	mathInline: M.NodeType<'mathInline'>,
	mention: M.NodeType<'mention'> | string,
	hashtag: M.NodeType<'hashtag'>,
	emojiCode: M.NodeType<'emojiCode'>,
	link: M.NodeType<'link'>,
	url: M.NodeType<'url'> | string,
	urlAlt: M.NodeType<'url'>,
	search: M.NodeType<'search'>,
	text: string,
}

export const language = P.createLanguage<TypeTable>({
	fullParser: r => {
		return r.full.many(0);
	},

	simpleParser: r => {
		return r.simple.many(0);
	},

	full: r => {
		return P.alt([
			// Regexp
			r.unicodeEmoji,
			// "<center>" block
			P.first('\r\n<', block(1, '<', r.centerTag)),
			// "<small>"
			P.first('<', r.smallTag),
			// "<plain>"
			P.first('<', r.plainTag),
			// "<b>"
			P.first('<', r.boldTag),
			// "<i>"
			P.first('<', r.italicTag),
			// "<s>"
			P.first('<', r.strikeTag),
			// "<http"
			P.first('<', r.urlAlt),
			// "***"
			P.first('*', r.big),
			// "**"
			P.first('*', r.boldAsta),
			// "*"
			P.first('*', r.italicAsta),
			// "__"
			P.first('_', r.boldUnder),
			// "_"
			P.first('_', r.italicUnder),
			// "```" block
			P.first('\r\n`', block(1, '`', r.codeBlock)),
			// "`"
			P.first('`', r.inlineCode),
			// ">" block
			P.first('\r\n>', block(2, '>', r.quote)),
			// "\\[" block
			P.first('\r\n\\', block(1, '\\', r.mathBlock)),
			// "\\("
			P.first('\\', r.mathInline),
			// "~~"
			P.first('~', r.strikeWave),
			// "$[""
			P.first('$', r.fn),
			// "@"
			P.first('@', r.mention),
			// "#"
			P.first('#', r.hashtag),
			// ":"
			P.first(':', r.emojiCode),
			// "?[" or "["
			P.first('?[', r.link),
			// http
			P.first('h', r.url),
			// block
			r.search,
			r.text,
		]);
	},

	simple: r => {
		return P.alt([
			r.unicodeEmoji, // Regexp
			P.first(':', r.emojiCode), // ":"
			P.first('<', r.plainTag), // "<plain>" // to NOT parse emojiCode inside `<plain>`
			r.text,
		]);
	},

	inline: r => {
		return P.alt([
			// Regexp
			r.unicodeEmoji,
			// "<small>"
			P.first('<', r.smallTag),
			// "<plain>"
			P.first('<', r.plainTag),
			// "<b>"
			P.first('<', r.boldTag),
			// "<i>"
			P.first('<', r.italicTag),
			// "<s>"
			P.first('<', r.strikeTag),
			// <http
			P.first('<', r.urlAlt),
			// "***"
			P.first('*', r.big),
			// "**"
			P.first('*', r.boldAsta),
			// "*"
			P.first('*', r.italicAsta),
			// "__"
			P.first('_', r.boldUnder),
			// "_"
			P.first('_', r.italicUnder),
			// "`"
			P.first('`', r.inlineCode),
			// "\\("
			P.first('\\', r.mathInline),
			// "~~"
			P.first('~', r.strikeWave),
			// "$[""
			P.first('$', r.fn),
			// "@"
			P.first('@', r.mention),
			// "#"
			P.first('#', r.hashtag),
			// ":"
			P.first(':', r.emojiCode),
			// "?[" or "["
			P.first('?[', r.link),
			// http
			P.first('h', r.url),
			r.text,
		]);
	},

	quote: r => {
		const lines: P.Parser<string[]> = P.seq( 
			P.str('>'),
			space.option(),
			P.seq(P.notMatch(newLine), P.char).select(1).many(0).text(),
		).select(2).sep(newLine, 1);
		const parser = P.seq( 
			newLine.option(),
			newLine.option(),
			P.lineBegin,
			lines,
			newLine.option(),
			newLine.option(),
		).select(3);
		return new P.Parser((input, index, state) => {
			let result;
			// parse quote
			result = parser.handler(input, index, state);
			if (!result.success) {
				return result;
			}
			const contents = result.value;
			const quoteIndex = result.index;
			// disallow empty content if single line
			if (contents.length === 1 && contents[0].length === 0) {
				return P.failure();
			}
			// parse inner content
			const contentParser = nest(r.fullParser).many(0);
			result = contentParser.handler(contents.join('\n'), 0, state);
			if (!result.success) {
				return result;
			}
			return P.success(quoteIndex, M.QUOTE(mergeText(result.value)));
		});
	},

	codeBlock: () => {
		const mark = P.str('```');
		return P.seq(
			newLine.option(),
			P.lineBegin,
			mark,
			P.seq(P.notMatch(newLine), P.char).select(1).many(0),
			newLine,
			P.until(P.seq(newLine, mark, P.lineEnd), 1),
			newLine,
			mark,
			P.lineEnd,
			newLine.option(),
		).map(result => {
			const lang = result[3].join('').trim();
			const code = result[5];
			return M.CODE_BLOCK(code, (lang.length > 0 ? lang : null));
		});
	},

	mathBlock: () => {
		const open = P.str('\\[');
		const close = P.str('\\]');
		return P.seq(
			newLine.option(),
			P.lineBegin,
			open,
			newLine.option(),
			P.until(P.seq(newLine.option(), close), 1),
			newLine.option(),
			close,
			P.lineEnd,
			newLine.option(),
		).map(result => {
			const formula = result[4];
			return M.MATH_BLOCK(formula);
		});
	},

	centerTag: r => {
		const open = P.str('<center>');
		const close = P.str('</center>');
		return P.seq(
			newLine.option(),
			P.lineBegin,
			open,
			newLine.option(),
			P.manyThen(
				nest(r.inline),
				P.seq(newLine.option(), close),
				P.seq(
					newLine.option(),
					close,
					P.lineEnd,
					newLine.option(),
				),
				1,
			),
		).map(result => {
			return M.CENTER(mergeText(result[4][0]));
		});
	},

	big: r => {
		const mark = P.str('***');
		return seqOrText(
			mark,
			P.except(nest(r.inline), mark).many(1),
			mark,
		).map(result => {
			if (typeof result === 'string') return result;
			return M.FN('tada', {}, mergeText(result[1]));
		});
	},

	boldAsta: r => {
		const mark = P.str('**');
		return seqOrText(
			mark,
			P.except(nest(r.inline), mark).many(1),
			mark,
		).map(result => {
			if (typeof result === 'string') return result;
			return M.BOLD(mergeText(result[1]));
		});
	},

	boldTag: r => {
		const open = P.str('<b>');
		const close = P.str('</b>');
		return seqOrText(
			open,
			P.except(nest(r.inline), close).many(1),
			close,
		).map(result => {
			if (typeof result === 'string') return result;
			return M.BOLD(mergeText(result[1]));
		});
	},

	boldUnder: () => {
		const mark = P.str('__');
		return P.seq(
			mark,
			P.alt([alphaAndNum, space]).many(1),
			mark,
		).map(result => M.BOLD(mergeText(result[1])));
	},

	smallTag: r => {
		const open = P.str('<small>');
		const close = P.str('</small>');
		return seqOrText(
			open,
			P.except(nest(r.inline), close).many(1),
			close,
		).map(result => {
			if (typeof result === 'string') return result;
			return M.SMALL(mergeText(result[1]));
		});
	},

	italicTag: r => {
		const open = P.str('<i>');
		const close = P.str('</i>');
		return seqOrText(
			open,
			P.except(nest(r.inline), close).many(1),
			close,
		).map(result => {
			if (typeof result === 'string') return result;
			return M.ITALIC(mergeText(result[1]));
		});
	},

	italicAsta: () => {
		const mark = P.str('*');
		const parser = P.seq(
			mark,
			P.alt([alphaAndNum, space]).many(1),
			mark,
		);
		return new P.Parser((input, index, state) => {
			const result = parser.handler(input, index, state);
			if (!result.success) {
				return P.failure();
			}
			// check before
			if (alphaAndNumBefore(input, index)) {
				return P.failure();
			}
			return P.success(result.index, M.ITALIC(mergeText(result.value[1])));
		});
	},

	italicUnder: () => {
		const mark = P.str('_');
		const parser = P.seq(
			mark,
			P.alt([alphaAndNum, space]).many(1),
			mark,
		);
		return new P.Parser((input, index, state) => {
			const result = parser.handler(input, index, state);
			if (!result.success) {
				return P.failure();
			}
			// check before
			if (alphaAndNumBefore(input, index)) {
				return P.failure();
			}
			return P.success(result.index, M.ITALIC(mergeText(result.value[1])));
		});
	},

	strikeTag: r => {
		const open = P.str('<s>');
		const close = P.str('</s>');
		return seqOrText(
			open,
			P.except(nest(r.inline), close).many(1),
			close,
		).map(result => {
			if (typeof result === 'string') return result;
			return M.STRIKE(mergeText(result[1]));
		});
	},

	strikeWave: r => {
		const mark = P.str('~~');
		return seqOrText(
			mark,
			P.except(nest(r.inline), P.alt([mark, newLine])).many(1),
			mark,
		).map(result => {
			if (typeof result === 'string') return result;
			return M.STRIKE(mergeText(result[1]));
		});
	},

	unicodeEmoji: () => {
		const emoji = RegExp(emojiRegex.source);
		const parser = P.regexp(emoji).map(content => {
			// 異体字セレクタ(U+FE0F)の場合は文字として返す
			return content === '\uFE0F' ? content : M.UNI_EMOJI(content);
		});
		// skip the large emoji regexp where no emoji can start
		return new P.Parser((input, index, state) => {
			const code = input.charCodeAt(index);
			if (cannotStartEmoji(code) || (code < 0x80 && cannotStartKeycap(input.charCodeAt(index + 1)))) {
				return P.failure();
			}
			return parser.handler(input, index, state);
		});
	},

	plainTag: () => {
		const open = P.str('<plain>');
		const close = P.str('</plain>');
		return P.seq( 
			open,
			newLine.option(),
			P.until(P.seq(newLine.option(), close), 1),
			newLine.option(),
			close,
		).select(2).map(result => M.PLAIN(result));
	},

	fn: r => {
		const fnName = P.regexp(/[a-z0-9_]+/i);
		const arg: P.Parser<ArgPair> = P.seq(
			P.regexp(/[a-z0-9_]+/i),
			P.seq(
				P.str('='),
				P.regexp(/[a-z0-9_.-]+/i),
			).select(1).option(),
		).map(result => {
			return {
				k: result[0],
				v: result[1] ?? true,
			};
		});
		const args = P.seq(
			P.str('.'),
			arg.sep(P.str(','), 1),
		).select(1).map(pairs => {
			const result: Args = { };
			for (const pair of pairs) {
				result[pair.k] = pair.v;
			}
			return result;
		});
		const fnClose = P.str(']');
		return seqOrText(
			P.str('$['),
			fnName,
			args.option(),
			P.str(' '),
			P.except(nest(r.inline), fnClose).many(1),
			fnClose,
		).map(result => {
			if (typeof result === 'string') return result;
			const name = result[1];
			const args: Args = result[2] || {};
			const content = result[4];
			return M.FN(name, args, mergeText(content));
		});
	},

	inlineCode: () => {
		const mark = P.str('`');
		return P.seq(
			mark,
			P.until(P.alt([mark, P.str('´'), newLine]), 1),
			mark,
		).map(result => M.INLINE_CODE(result[1]));
	},

	mathInline: () => {
		const open = P.str('\\(');
		const close = P.str('\\)');
		return P.seq(
			open,
			P.until(P.alt([close, newLine]), 1),
			close,
		).map(result => M.MATH_INLINE(result[1]));
	},

	mention: () => {
		const parser = P.seq(
			notLinkLabel,
			P.str('@'),
			P.regexp(/[a-z0-9_.-]+/i),
			P.seq(
				P.str('@'),
				P.regexp(/[a-z0-9_.-]+/i),
			).select(1).option(),
		);
		return new P.Parser<M.MfmMention | string>((input, index, state) => {
			let result;
			result = parser.handler(input, index, state);
			if (!result.success) {
				return P.failure();
			}
			// check before (not mention)
			if (alphaAndNumBefore(input, index)) {
				return P.failure();
			}
			let invalidMention = false;
			const resultIndex = result.index;
			const username: string = result.value[2];
			const hostname: string | null = result.value[3];
			// remove [.-] of tail of hostname
			let modifiedHost = hostname;
			if (hostname != null) {
				const trailing = trailingLength(hostname, '.-');
				if (trailing > 0) {
					modifiedHost = hostname.slice(0, (-1 * trailing));
					if (modifiedHost.length === 0) {
						// disallow invalid char only hostname
						invalidMention = true;
						modifiedHost = null;
					}
				}
			}
			// remove [.-] of tail of username
			let modifiedName = username;
			const trailing = trailingLength(username, '.-');
			if (trailing > 0) {
				if (modifiedHost == null) {
					modifiedName = username.slice(0, (-1 * trailing));
				} else {
					// cannnot to remove tail of username if exist hostname
					invalidMention = true;
				}
			}
			// disallow [.-] of head of username
			if (modifiedName.length === 0 || /^[.-]/.test(modifiedName)) {
				invalidMention = true;
			}
			// disallow [.-] of head of hostname
			if (modifiedHost != null && /^[.-]/.test(modifiedHost)) {
				invalidMention = true;
			}
			// generate a text if mention is invalid
			if (invalidMention) {
				return P.success(resultIndex, input.slice(index, resultIndex));
			}
			const acct = modifiedHost != null ? `@${modifiedName}@${modifiedHost}` : `@${modifiedName}`;
			return P.success(index + acct.length, M.MENTION(modifiedName, modifiedHost, acct));
		});
	},

	hashtag: () => {
		const mark = P.str('#');
		// same as `P.seq(P.notMatch(P.alt([P.regexp(/[ \u3000\t.,!?'"#:/[\]【】()「」（）<>]/), space, newLine])), P.char).select(1)`
		const hashTagStops = ' \u3000\t.,!?\'"#:/[]【】()「」（）<>\r\n';
		const hashTagChar = new P.Parser<string>((input, index, _state) => {
			if (index >= input.length) {
				return P.failure();
			}
			const char = input.charAt(index);
			return hashTagStops.includes(char) ? P.failure() : P.success(index + 1, char);
		});
		const innerItem: P.Parser<unknown> = P.lazy(() => P.alt([
			P.seq(
				P.str('('), nest(innerItem, hashTagChar).many(0), P.str(')'),
			),
			P.seq(
				P.str('['), nest(innerItem, hashTagChar).many(0), P.str(']'),
			),
			P.seq(
				P.str('「'), nest(innerItem, hashTagChar).many(0), P.str('」'),
			),
			P.seq(
				P.str('（'), nest(innerItem, hashTagChar).many(0), P.str('）'),
			),
			hashTagChar,
		]));
		// same as `innerItem` at the top level: a run of `hashTagChar` is consumed at once since the other items cannot start with it
		const hashTagChars = new P.Parser<string>((input, index, _state) => {
			let end = index;
			while (end < input.length && !hashTagStops.includes(input.charAt(end))) {
				end++;
			}
			return (end === index) ? P.failure() : P.success(end, input.slice(index, end));
		});
		const topItem: P.Parser<unknown> = P.alt([
			P.seq(
				P.str('('), nest(innerItem, hashTagChar).many(0), P.str(')'),
			),
			P.seq(
				P.str('['), nest(innerItem, hashTagChar).many(0), P.str(']'),
			),
			P.seq(
				P.str('「'), nest(innerItem, hashTagChar).many(0), P.str('」'),
			),
			P.seq(
				P.str('（'), nest(innerItem, hashTagChar).many(0), P.str('）'),
			),
			hashTagChars,
		]);
		const parser = P.seq( 
			notLinkLabel,
			mark,
			topItem.many(1).text(),
		).select(2);
		return new P.Parser((input, index, state) => {
			const result = parser.handler(input, index, state);
			if (!result.success) {
				return P.failure();
			}
			// check before
			if (alphaAndNumBefore(input, index)) {
				return P.failure();
			}
			const resultIndex = result.index;
			const resultValue = result.value;
			// disallow number only
			if (/^[0-9]+$/.test(resultValue)) {
				return P.failure();
			}
			return P.success(resultIndex, M.HASHTAG(resultValue));
		});
	},

	emojiCode: () => {
		const side = P.notMatch(P.regexp(/[a-z0-9]/i));
		const mark = P.str(':');
		return P.seq( 
			P.alt([P.lineBegin, side]),
			mark,
			P.regexp(/[a-z0-9_+-]+/i),
			mark,
			P.alt([P.lineEnd, side]),
		).select(2).map(name => M.EMOJI_CODE(name));
	},

	link: r => {
		const labelInline = new P.Parser((input, index, state) => {
			state.linkLabel = true;
			const result = r.inline.handler(input, index, state);
			state.linkLabel = false;
			return result;
		});
		const closeLabel = P.str(']');
		const afterLabel = P.seq(
			closeLabel,
			P.str('('),
			P.alt([r.urlAlt, r.url]),
			P.str(')'),
		).select(2);
		// fail on an invalid url (a string) so that `manyThen` caches the failure
		const afterLabelUrl = new P.Parser<M.MfmUrl>((input, index, state) => {
			const result = afterLabel.handler(input, index, state);
			if (!result.success || typeof result.value === 'string') {
				return P.failure();
			}
			return P.success(result.index, result.value);
		});
		return P.seq(
			notLinkLabel,
			P.alt([P.str('?['), P.str('[')]),
			P.manyThen(
				nest(labelInline),
				P.alt([closeLabel, newLine]),
				afterLabelUrl,
				1,
			),
		).map(result => {
			const silent = (result[1] === '?[');
			const [label, url] = result[2];
			return M.LINK(silent, url.props.url, mergeText(label));
		});
	},

	url: () => {
		const urlChar = P.regexp(/[.,a-z0-9_/:%#@$&?!~=+-]/i);
		const innerItem: P.Parser<unknown> = P.lazy(() => P.alt([
			P.seq(
				P.str('('), nest(innerItem, urlChar).many(0), P.str(')'),
			),
			P.seq(
				P.str('['), nest(innerItem, urlChar).many(0), P.str(']'),
			),
			urlChar,
		]));
		// same as `innerItem` at the top level: a run of `urlChar` is consumed at once since the other items cannot start with it
		const urlChars = P.regexp(/[.,a-z0-9_/:%#@$&?!~=+-]+/i);
		const topItem: P.Parser<unknown> = P.alt([
			P.seq(
				P.str('('), nest(innerItem, urlChar).many(0), P.str(')'),
			),
			P.seq(
				P.str('['), nest(innerItem, urlChar).many(0), P.str(']'),
			),
			urlChars,
		]);
		const parser = P.seq(
			notLinkLabel,
			P.regexp(/https?:\/\//),
			topItem.many(1).text(),
		);
		return new P.Parser<M.MfmUrl | string>((input, index, state) => {
			let result;
			result = parser.handler(input, index, state);
			if (!result.success) {
				return P.failure();
			}
			const resultIndex = result.index;
			let modifiedIndex = resultIndex;
			const schema: string = result.value[1];
			let content: string = result.value[2];
			// remove the ".," at the right end
			const trailing = trailingLength(content, '.,');
			if (trailing > 0) {
				modifiedIndex -= trailing;
				content = content.slice(0, (-1 * trailing));
				if (content.length === 0) {
					return P.success(resultIndex, input.slice(index, resultIndex));
				}
			}
			return P.success(modifiedIndex, M.N_URL(schema + content, false));
		});
	},

	urlAlt: () => {
		const open = P.str('<');
		const close = P.str('>');
		const parser = P.seq(
			notLinkLabel,
			open,
			P.regexp(/https?:\/\//),
			P.until(P.alt([close, space]), 1),
			close,
		).text();
		return new P.Parser((input, index, state) => {
			const result = parser.handler(input, index, state);
			if (!result.success) {
				return P.failure();
			}
			const text = result.value.slice(1, (result.value.length - 1));
			return P.success(result.index, M.N_URL(text, true));
		});
	},

	search: () => {
		const button = P.alt([
			P.regexp(/\[(検索|search)\]/i),
			P.regexp(/(検索|search)/i),
		]);
		const parser = P.seq(
			newLine.option(),
			P.lineBegin,
			P.until(P.alt([
				newLine,
				P.seq(space, button, P.lineEnd),
			]), 1),
			space,
			button,
			P.lineEnd,
			newLine.option(),
		).map(result => {
			const query = result[2];
			return M.SEARCH(query, `${query}${result[3]}${result[4]}`);
		});
		// a search block can only start at a line beginning or at a newline right before it
		return new P.Parser((input, index, state) => {
			const current = input.charCodeAt(index);
			const before = input.charCodeAt(index - 1);
			if (index !== 0 && !P.isNewLineCode(current) && !P.isNewLineCode(before)) {
				return P.failure();
			}
			// the button must be at the end of the line, so the line has to end with `索`, `h` or one of them followed by `]`
			let lineEnd = index;
			if (current === 0x0d && input.charCodeAt(index + 1) === 0x0a) {
				lineEnd += 2;
			} else if (P.isNewLineCode(current)) {
				lineEnd++;
			}
			while (lineEnd < input.length && !P.isNewLineCode(input.charCodeAt(lineEnd))) {
				lineEnd++;
			}
			const last = input.charCodeAt(input.charCodeAt(lineEnd - 1) === 0x5d ? lineEnd - 2 : lineEnd - 1);
			if (last !== 0x7d22 && last !== 0x68 && last !== 0x48) {
				return P.failure();
			}
			return parser.handler(input, index, state);
		});
	},

	// Every other syntax has already failed at `index`, so the char there is text.
	// The following plain text code units cannot start or close any syntax either, so they are consumed at once.
	text: () => new P.Parser((input, index, _state) => {
		if (index >= input.length) {
			return P.failure();
		}
		const end = P.isNewLineCode(input.charCodeAt(index)) ? index + 1 : plainTextEnd(input, index + 1);
		return P.success(end, input.slice(index, end));
	}),
});

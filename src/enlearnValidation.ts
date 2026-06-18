import { normalizeAsciiPunctuation } from './punctuation';

export type EnlearnDiagnosticKind = 'spelling' | 'grammar' | 'usage' | 'format';
export type EnlearnDiagnosticSeverity = 'error' | 'warning';

export interface EnlearnTextRange {
	line: number;
	startCharacter: number;
	endCharacter: number;
}

export interface EnlearnValidationIssue {
	kind: EnlearnDiagnosticKind;
	message: string;
	severity: EnlearnDiagnosticSeverity;
	text?: string;
	suggestion?: string;
	segmentId?: string;
	range?: EnlearnTextRange;
}

export interface EnglishWordMatch {
	text: string;
	line: number;
	startCharacter: number;
	endCharacter: number;
}

export interface ChineseTextMatch {
	text: string;
	line: number;
	startCharacter: number;
	endCharacter: number;
}

export interface CommentTextMatch {
	text: string;
	line: number;
	startCharacter: number;
	endCharacter: number;
}

export interface SemanticLineMatch {
	text: string;
	line: number;
	startCharacter: number;
	endCharacter: number;
}

export interface EnlearnCheckableSegment {
	id: string;
	text: string;
	hash: string;
	range: EnlearnTextRange;
}

const ENGLISH_WORD_PATTERN = /\b[A-Za-z]+(?:[-'][A-Za-z]+)*\b/g;
const CHINESE_TEXT_PATTERN = /[\u3400-\u9fff]+(?:[，。！？、；：“”‘’（）《》\u3400-\u9fff]*)/gu;
const ALLOWED_VOCABULARY_FIELDS = new Set(['meaning', 'phonetic', 'example', 'note']);
const BLOCKED_AI_LINE_PATTERN = /^\s*(?:=|@|\[word\]|\/\/|#)/;
const CHECKABLE_PREFIX_PATTERNS = [
	/^\s*>\s*/,
	/^\s*!\s*/,
	/^\s*:\s*example\b\s*/i,
	/^\s*\?\s*(?:cloze|translate)\b\s*/i
];

export function findEnglishWords(text: string): EnglishWordMatch[] {
	const matches: EnglishWordMatch[] = [];
	const lines = text.split(/\r?\n/);

	for (let line = 0; line < lines.length; line++) {
		const pattern = new RegExp(ENGLISH_WORD_PATTERN);
		let match: RegExpExecArray | null;

		while ((match = pattern.exec(lines[line])) !== null) {
			matches.push({
				text: match[0],
				line,
				startCharacter: match.index,
				endCharacter: match.index + match[0].length
			});
		}
	}

	return matches;
}

export function findChineseText(text: string): ChineseTextMatch[] {
	const matches: ChineseTextMatch[] = [];
	const lines = text.split(/\r?\n/);

	for (let line = 0; line < lines.length; line++) {
		const pattern = new RegExp(CHINESE_TEXT_PATTERN);
		let match: RegExpExecArray | null;

		while ((match = pattern.exec(lines[line])) !== null) {
			matches.push({
				text: match[0],
				line,
				startCharacter: match.index,
				endCharacter: match.index + match[0].length
			});
		}
	}

	return matches;
}

export function findCommentText(text: string): CommentTextMatch[] {
	return [
		...findLineCommentText(text),
		...findParentheticalText(text)
	].sort((first, second) =>
		first.line - second.line || first.startCharacter - second.startCharacter
	);
}

export function findQuestionLines(text: string): SemanticLineMatch[] {
	return findSemanticLines(text, '?');
}

export function findFeedbackLines(text: string): SemanticLineMatch[] {
	return findSemanticLines(text, '!');
}

function findSemanticLines(text: string, marker: '?' | '!'): SemanticLineMatch[] {
	const matches: SemanticLineMatch[] = [];
	const lines = text.split(/\r?\n/);

	for (let line = 0; line < lines.length; line++) {
		const firstNonWhitespace = lines[line].search(/\S/);
		if (firstNonWhitespace >= 0 && lines[line][firstNonWhitespace] === marker) {
			matches.push({
				text: lines[line],
				line,
				startCharacter: 0,
				endCharacter: Math.max(lines[line].length, 1)
			});
		}
	}

	return matches;
}

export function findLineCommentText(text: string): CommentTextMatch[] {
	const matches: CommentTextMatch[] = [];
	const lines = text.split(/\r?\n/);

	for (let line = 0; line < lines.length; line++) {
		const startCharacter = lines[line].indexOf('//');
		if (startCharacter >= 0) {
			matches.push({
				text: lines[line].slice(startCharacter),
				line,
				startCharacter,
				endCharacter: lines[line].length
			});
		}
	}

	return matches;
}

export function findParentheticalText(text: string): CommentTextMatch[] {
	const matches: CommentTextMatch[] = [];
	const lines = text.split(/\r?\n/);

	for (let line = 0; line < lines.length; line++) {
		const stack: Array<{ startCharacter: number; close: string }> = [];
		const value = lines[line];

		for (let character = 0; character < value.length; character++) {
			const current = value[character];
			if (current === '(' || current === '（') {
				stack.push({
					startCharacter: character,
					close: current === '(' ? ')' : '）'
				});
				continue;
			}

			let openIndex = -1;
			for (let stackIndex = stack.length - 1; stackIndex >= 0; stackIndex--) {
				if (stack[stackIndex].close === current) {
					openIndex = stackIndex;
					break;
				}
			}
			if (openIndex >= 0) {
				const open = stack[openIndex];
				stack.splice(openIndex);
				matches.push({
					text: value.slice(open.startCharacter, character + 1),
					line,
					startCharacter: open.startCharacter,
					endCharacter: character + 1
				});
			}
		}
	}

	return matches;
}

export function extractCheckableEnglishSegments(text: string): EnlearnCheckableSegment[] {
	const segments: EnlearnCheckableSegment[] = [];
	const lines = text.split(/\r?\n/);

	for (let line = 0; line < lines.length; line++) {
		const segment = extractLineSegment(lines[line], line);
		if (segment) {
			segments.push(segment);
		}
	}

	return segments;
}

export function hashText(text: string): string {
	let hash = 2166136261;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}

	return (hash >>> 0).toString(16).padStart(8, '0');
}

export function validateEnlearnFormatText(text: string): EnlearnValidationIssue[] {
	const issues: EnlearnValidationIssue[] = [];
	const lines = text.split(/\r?\n/);

	for (let line = 0; line < lines.length; line++) {
		const value = lines[line];
		const trimmed = value.trim();

		if (trimmed.startsWith('@') && !/^@[A-Za-z][\w-]*(?:\s+\S.*)?$/.test(trimmed)) {
			issues.push(createLineIssue(line, value, 'format', '格式错误：元数据必须写成 @key value。'));
		}

		if (/^\s*\[word\]\s*$/.test(value)) {
			issues.push(createLineIssue(line, value, 'format', '格式错误：[word] 后必须填写英文单词或短语。'));
		}

		const fieldMatch = /^\s*:\s*([A-Za-z-]+)\b/.exec(value);
		if (fieldMatch && !ALLOWED_VOCABULARY_FIELDS.has(fieldMatch[1])) {
			issues.push({
				kind: 'format',
				message: `格式错误：未知词条字段 "${fieldMatch[1]}"。允许字段：meaning, phonetic, example, note。`,
				severity: 'error',
				range: {
					line,
					startCharacter: fieldMatch.index + value.indexOf(fieldMatch[1]),
					endCharacter: fieldMatch.index + value.indexOf(fieldMatch[1]) + fieldMatch[1].length
				}
			});
		}

		issues.push(...validateClozeSegments(value, line));
	}

	return issues;
}

export function parseAiValidationIssues(content: string): EnlearnValidationIssue[] {
	const parsed: unknown = JSON.parse(stripJsonFence(content));
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return [];
	}

	const rawIssues = (parsed as { issues?: unknown }).issues;
	if (!Array.isArray(rawIssues)) {
		return [];
	}

	return rawIssues.flatMap(item => {
		if (!item || typeof item !== 'object' || Array.isArray(item)) {
			return [];
		}

		const object = item as Record<string, unknown>;
		const message = readString(object.message);
		const text = readString(object.text);
		if (!message || !text) {
			return [];
		}
		if (isPunctuationStyleIssue(message, text, readString(object.suggestion))) {
			return [];
		}

		return [{
			kind: readDiagnosticKind(object.kind) ?? 'grammar',
			message,
			severity: readDiagnosticSeverity(object.severity) ?? 'error',
			text,
			segmentId: readString(object.segmentId),
			suggestion: readString(object.suggestion)
		}];
	});
}

export function isPunctuationStyleIssue(message: string, text = '', suggestion = '') {
	const normalized = `${message} ${text} ${suggestion}`.toLowerCase();
	const mentionsPunctuation = /标点|逗号|句号|punctuation|comma|period|full stop/.test(normalized);
	const mentionsStyle = /中文标点|英文标点|ascii|全角|半角|中文逗号|中文句号|英文逗号|英文句号/.test(normalized);

	return mentionsPunctuation && mentionsStyle;
}

function extractLineSegment(lineText: string, line: number): EnlearnCheckableSegment | undefined {
	if (BLOCKED_AI_LINE_PATTERN.test(lineText) || !/[A-Za-z]/.test(lineText)) {
		return undefined;
	}

	const prefixLength = readCheckablePrefixLength(lineText);
	const contentStartInRemainder = lineText.slice(prefixLength).search(/\S/);
	if (contentStartInRemainder < 0) {
		return undefined;
	}

	const startCharacter = prefixLength + contentStartInRemainder;
	const rawContent = lineText.slice(startCharacter);
	const text = rawContent.trimEnd();
	if (!/[A-Za-z]/.test(text)) {
		return undefined;
	}

	const hash = hashText(text);
	return {
		id: `line-${line}-${hash}`,
		text,
		hash,
		range: {
			line,
			startCharacter,
			endCharacter: startCharacter + text.length
		}
	};
}

function readCheckablePrefixLength(lineText: string) {
	for (const pattern of CHECKABLE_PREFIX_PATTERNS) {
		const match = pattern.exec(lineText);
		if (match) {
			return match[0].length;
		}
	}

	const firstNonWhitespace = lineText.search(/\S/);
	return firstNonWhitespace < 0 ? 0 : firstNonWhitespace;
}

function validateClozeSegments(lineText: string, line: number): EnlearnValidationIssue[] {
	const issues: EnlearnValidationIssue[] = [];
	const clozePattern = /\{([^{}\n]*)\}/g;
	const openCount = countCharacter(lineText, '{');
	const closeCount = countCharacter(lineText, '}');

	if (openCount !== closeCount) {
		issues.push(createLineIssue(line, lineText, 'format', '格式错误：cloze 标记的大括号不匹配，应写成 {answer|hint}。'));
		return issues;
	}

	let match: RegExpExecArray | null;
	while ((match = clozePattern.exec(lineText)) !== null) {
		if (!/^[^|{}]+[|][^{}]+$/.test(match[1])) {
			issues.push({
				kind: 'format',
				message: '格式错误：cloze 标记必须写成 {answer|hint}。',
				severity: 'error',
				range: {
					line,
					startCharacter: match.index,
					endCharacter: match.index + match[0].length
				}
			});
		}
	}

	return issues;
}

function createLineIssue(line: number, text: string, kind: EnlearnDiagnosticKind, message: string): EnlearnValidationIssue {
	return {
		kind,
		message,
		severity: 'error',
		range: {
			line,
			startCharacter: 0,
			endCharacter: Math.max(text.length, 1)
		}
	};
}

function countCharacter(text: string, character: string) {
	return [...text].filter(item => item === character).length;
}

function stripJsonFence(content: string) {
	return content.trim()
		.replace(/^```json\s*/i, '')
		.replace(/^```\s*/i, '')
		.replace(/\s*```$/i, '')
		.trim();
}

function readString(value: unknown) {
	return typeof value === 'string' && value.trim().length > 0 ? normalizeAsciiPunctuation(value.trim()) : undefined;
}

function readDiagnosticKind(value: unknown): EnlearnDiagnosticKind | undefined {
	if (value === 'spelling' || value === 'grammar' || value === 'usage' || value === 'format') {
		return value;
	}

	return undefined;
}

function readDiagnosticSeverity(value: unknown): EnlearnDiagnosticSeverity | undefined {
	if (value === 'error' || value === 'warning') {
		return value;
	}

	return undefined;
}

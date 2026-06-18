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
	range?: EnlearnTextRange;
}

export interface EnglishWordMatch {
	text: string;
	line: number;
	startCharacter: number;
	endCharacter: number;
}

const ENGLISH_WORD_PATTERN = /\b[A-Za-z]+(?:[-'][A-Za-z]+)*\b/g;
const ALLOWED_VOCABULARY_FIELDS = new Set(['meaning', 'phonetic', 'example', 'note']);

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

		return [{
			kind: readDiagnosticKind(object.kind) ?? 'grammar',
			message,
			severity: readDiagnosticSeverity(object.severity) ?? 'error',
			text,
			suggestion: readString(object.suggestion)
		}];
	});
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
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
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

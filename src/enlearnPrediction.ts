import { normalizeAsciiPunctuation } from './punctuation';

export interface PredictionPosition {
	line: number;
	character: number;
}

export interface EnlearnPredictionResult {
	completion: string;
	translation: string;
}

const BLOCKED_LINE_PATTERN = /^\s*(?:=|@|\[word\]|\/\/)/;
const ENGLISH_LINE_PATTERN = /[A-Za-z]/;
const CJK_PATTERN = /[\u3400-\u9fff]/u;

export function shouldTriggerPrediction(lineTextBeforeCursor: string): boolean {
	const trimmed = lineTextBeforeCursor.trim();

	if (!trimmed || BLOCKED_LINE_PATTERN.test(trimmed) || !ENGLISH_LINE_PATTERN.test(trimmed)) {
		return false;
	}

	return true;
}

export function buildPredictionContext(documentText: string, position: PredictionPosition, maxContextChars: number): string {
	const offset = offsetAt(documentText, position);
	const context = documentText.slice(0, offset);

	if (context.length <= maxContextChars) {
		return context;
	}

	return context.slice(context.length - maxContextChars);
}

export function parsePredictionResult(content: string): EnlearnPredictionResult | undefined {
	const parsed: unknown = JSON.parse(stripJsonFence(content));
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return undefined;
	}

	const object = parsed as Record<string, unknown>;
	const completion = cleanCompletion(readString(object.completion));
	const translation = readString(object.translation);

	if (!completion || !translation || CJK_PATTERN.test(completion)) {
		return undefined;
	}

	return {
		completion,
		translation
	};
}

export function cleanCompletion(value: string | undefined) {
	if (!value) {
		return undefined;
	}

	const withoutLineBreaks = value.replace(/\s*\r?\n\s*/g, ' ').trim();
	const firstSentence = /^(.+?[.!?])(?:\s|$)/.exec(withoutLineBreaks)?.[1] ?? withoutLineBreaks;
	const normalized = firstSentence.replace(/\s+/g, ' ').trim();

	if (!normalized || normalized.length > 220) {
		return undefined;
	}

	return normalized;
}

function offsetAt(text: string, position: PredictionPosition) {
	const lines = text.split(/\r?\n/);
	let offset = 0;

	for (let line = 0; line < Math.min(position.line, lines.length); line++) {
		offset += lines[line].length + 1;
	}

	return offset + Math.min(position.character, lines[position.line]?.length ?? 0);
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

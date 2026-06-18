export interface RelatedWord {
	word: string;
	meaning: string;
	domain?: string;
	example?: string;
	note?: string;
}

export interface RelatedWordsResult {
	source: string;
	words: RelatedWord[];
}

const ENGLISH_WORD_PATTERN = /\b[A-Za-z]+(?:[-'][A-Za-z]+)*\b/g;

export function getEnglishWordAt(lineText: string, character: number): string | undefined {
	const pattern = new RegExp(ENGLISH_WORD_PATTERN);
	let match: RegExpExecArray | null;

	while ((match = pattern.exec(lineText)) !== null) {
		const start = match.index;
		const end = start + match[0].length;
		if (character >= start && character <= end) {
			return match[0];
		}
	}

	return undefined;
}

export function normalizeRelatedWordInput(value: string): string | undefined {
	const match = value.trim().match(ENGLISH_WORD_PATTERN);
	return match?.[0];
}

export function parseRelatedWordsResult(content: string): RelatedWordsResult | undefined {
	const parsed: unknown = JSON.parse(stripJsonFence(content));
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return undefined;
	}

	const object = parsed as Record<string, unknown>;
	const source = readString(object.source) ?? readString(object.word);
	const rawWords = object.words;
	if (!source || !Array.isArray(rawWords)) {
		return undefined;
	}

	const words = rawWords.flatMap(item => {
		if (!item || typeof item !== 'object' || Array.isArray(item)) {
			return [];
		}

		const wordObject = item as Record<string, unknown>;
		const word = readString(wordObject.word) ?? readString(wordObject.term);
		const meaning = readString(wordObject.meaning);
		if (!word || !meaning) {
			return [];
		}

		return [{
			word,
			meaning,
			domain: readString(wordObject.domain),
			example: readString(wordObject.example),
			note: readString(wordObject.note)
		}];
	}).slice(0, 5);

	if (words.length === 0) {
		return undefined;
	}

	return {
		source,
		words
	};
}

export function formatRelatedWordBlock(item: RelatedWord) {
	const lines = [
		`[word] ${item.word}`,
		`: meaning ${item.meaning}`
	];

	if (item.example) {
		lines.push(`: example ${item.example}`);
	}

	const notes = [item.domain ? `相关领域：${item.domain}` : undefined, item.note].filter(Boolean);
	if (notes.length > 0) {
		lines.push(`: note ${notes.join('；')}`);
	}

	return `${lines.join('\n')}\n`;
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

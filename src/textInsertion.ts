export interface TextSelectionRange {
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
}

export interface TextLine {
	lineNumber: number;
	text: string;
}

export function getLineAfterSelections(selections: TextSelectionRange[]) {
	const lastTouchedLine = Math.max(...selections.map(selection => {
		if (selection.endCharacter === 0 && selection.endLine > selection.startLine) {
			return selection.endLine - 1;
		}

		return selection.endLine;
	}));

	return lastTouchedLine + 1;
}

export function normalizeInsertedTranslation(value: string) {
	return value
		.split(/\r?\n/)
		.map(line => line.trimEnd())
		.join('\n')
		.trim();
}

export function collectSentenceContext(lines: TextLine[], selection: TextSelectionRange, maxLines = 6) {
	const collected: TextLine[] = [];
	const startIndex = lines.findIndex(line => line.lineNumber === selection.startLine);
	if (startIndex < 0) {
		return {
			text: '',
			endLine: selection.endLine
		};
	}

	let sentenceStartIndex = startIndex;
	while (sentenceStartIndex > 0 && startIndex - sentenceStartIndex + 1 < maxLines) {
		const previousLine = lines[sentenceStartIndex - 1].text.trim();
		if (isSentenceBoundaryBefore(previousLine)) {
			break;
		}

		sentenceStartIndex--;
	}

	for (let index = sentenceStartIndex; index < lines.length && collected.length < maxLines; index++) {
		const line = lines[index];
		if (index > startIndex && isBlockBoundary(line.text)) {
			break;
		}

		collected.push(line);
		if (endsSentence(line.text) && line.lineNumber >= selection.endLine) {
			break;
		}
	}

	return {
		text: collected.map(line => line.text.trim()).filter(Boolean).join('\n'),
		endLine: collected[collected.length - 1]?.lineNumber ?? selection.endLine
	};
}

export function normalizePsExplanation(value: string) {
	return value
		.replace(/^```json\s*/i, '')
		.replace(/^```\s*/i, '')
		.replace(/\s*```$/i, '')
		.replace(/^\s*[(（]?PS[:：]\s*/i, '')
		.replace(/[)）]?\s*$/i, '')
		.replace(/\s+/g, ' ')
		.trim();
}

export function formatPsExplanation(value: string) {
	const normalized = normalizePsExplanation(value);
	return normalized ? `（PS: ${normalized}）` : '';
}

function endsSentence(value: string) {
	return /[.!?。！？]\s*$/.test(value.trim());
}

function isSentenceBoundaryBefore(value: string) {
	return !value || endsSentence(value) || isBlockBoundary(value);
}

function isBlockBoundary(value: string) {
	return /^\s*(?:#|@|\[word\]|=|:|\?|\/\/)/i.test(value);
}

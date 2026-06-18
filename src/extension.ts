import { ChildProcess, spawn } from 'node:child_process';
import OpenAI from 'openai';
import { EdgeTTS } from 'node-edge-tts';
import * as vscode from 'vscode';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import {
	EnlearnCheckableSegment,
	EnlearnValidationIssue,
	extractCheckableEnglishSegments,
	findChineseText,
	findCommentText,
	findEnglishWords,
	findFeedbackLines,
	findQuestionLines,
	parseAiValidationIssues,
	validateEnlearnFormatText
} from './enlearnValidation';
import {
	EnlearnPredictionResult,
	buildPredictionContext,
	parsePredictionResult,
	shouldTriggerPrediction
} from './enlearnPrediction';
import {
	RelatedWord,
	RelatedWordsResult,
	formatRelatedWordBlock,
	getEnglishWordAt,
	normalizeRelatedWordInput,
	parseRelatedWordsResult
} from './relatedWords';
import { normalizeAsciiPunctuation } from './punctuation';
import {
	ENGLISH_LEARNING_ACTIONS,
	EnglishLearningAction
} from './sidebarActions';
import {
	DEFAULT_TTS_SETTINGS,
	TtsSettings,
	buildPowerShellMediaPlayerScript,
	createTtsCacheKey,
	normalizeTtsText,
	toTtsValidationMessage,
	validateTtsText
} from './tts';
import {
	TextSelectionRange,
	collectSentenceContext,
	formatInlineTranslation,
	formatPsExplanation,
	getLineAfterSelections,
	isSingleEnglishWord,
	normalizeInsertedTranslation
} from './textInsertion';

const DEEPSEEK_SECRET_KEY = 'englishLearning.deepseek.apiKey';
const LEARNING_RECORDS_KEY = 'englishLearning.records';
const MAX_LEARNING_RECORDS = 200;
const ENLEARN_LANGUAGE_ID = 'enlearn';
const ASCII_PUNCTUATION_PROMPT_RULE = 'All punctuation in JSON string values must be ASCII punctuation only. Use , . : ; ? ! ( ) " \' instead of Chinese punctuation, even when the text is Chinese.';

type LearningMode = 'translate' | 'explain' | 'annotate' | 'enlearn' | 'summarize';
type DeepSeekRequestMode = LearningMode | 'contextExplain' | 'contextTranslate' | 'practice' | 'gradePractice' | 'gradePracticeBatch';
type LearningDirection = 'en-to-zh' | 'zh-to-en' | 'mixed';
type PracticeQuestionType = 'translate' | 'cloze';

interface SelectedText {
	editor: vscode.TextEditor;
	text: string;
	sourceUri: string;
}

interface DeepSeekOptions {
	baseUrl: string;
	model: string;
	temperature: number;
}

interface VocabularyItem {
	term: string;
	meaning?: string;
	phonetic?: string;
	example?: string;
	note?: string;
}

interface PracticeQuestion {
	type: PracticeQuestionType;
	prompt: string;
}

interface PracticeGrading {
	correct: boolean;
	feedback?: string;
	correction?: string;
	explanation?: string;
}

export interface PracticeBatchItem {
	id: string;
	question: string;
	answer: string;
	startLine: number;
	endLine: number;
}

interface PracticeBatchGrading extends PracticeGrading {
	id: string;
}

interface PracticeBatchFeedback {
	item: PracticeBatchItem;
	feedback: string;
}

interface AiLearningResult {
	translation?: string;
	explanation?: string;
	summary?: string;
	notes: string[];
	grammar: string[];
	examples: string[];
	practice: string[];
	vocabulary: VocabularyItem[];
	questions: PracticeQuestion[];
	grading?: PracticeGrading;
	gradings: PracticeBatchGrading[];
	direction: LearningDirection;
}

interface DeepSeekResponse {
	options: DeepSeekOptions;
	result: AiLearningResult;
}

type DeepSeekRequester = (apiKey: string, mode: DeepSeekRequestMode, text: string) => Promise<DeepSeekResponse>;

interface LearningRecord {
	id: string;
	mode: LearningMode;
	sourceText: string;
	translation?: string;
	explanation?: string;
	annotation?: string;
	sourceUri: string;
	timestamp: string;
	direction: LearningDirection;
	model: string;
}

interface PredictionCacheEntry {
	key: string;
	completion: string;
	translation: string;
	insertRange: vscode.Range;
	hoverRange: vscode.Range;
}

interface AiValidationCacheEntry {
	text: string;
	issues: EnlearnValidationIssue[];
}

interface RelatedWordTarget {
	editor: vscode.TextEditor;
	word: string;
	sourceUri: string;
}

interface InlineTranslationTarget {
	contextText: string;
	insertPosition: vscode.Position;
}

interface PracticeOrGradeTarget {
	editor: vscode.TextEditor;
	documentText: string;
	selectedText: string;
}

let outputChannel: vscode.OutputChannel;
let enlearnDiagnosticCollection: vscode.DiagnosticCollection;
let englishWordDecorationType: vscode.TextEditorDecorationType | undefined;
let chineseTextDecorationType: vscode.TextEditorDecorationType | undefined;
let questionLineDecorationType: vscode.TextEditorDecorationType | undefined;
let feedbackLineDecorationType: vscode.TextEditorDecorationType | undefined;
let commentTextDecorationType: vscode.TextEditorDecorationType | undefined;
let missingValidationApiKeyNoticeShown = false;
const validationTimers = new Map<string, ReturnType<typeof setTimeout>>();
const validationSegmentSnapshots = new Map<string, Set<string>>();
const dirtyValidationSegmentHashes = new Map<string, Set<string>>();
const aiValidationCaches = new Map<string, Map<string, AiValidationCacheEntry>>();
let latestPrediction: PredictionCacheEntry | undefined;
const predictionCache = new Map<string, PredictionCacheEntry>();
let activeAudioPlayback: ChildProcess | undefined;
let testDeepSeekApiKey: string | undefined;
let testDeepSeekRequester: DeepSeekRequester | undefined;

function withDeepSeekNonThinking(params: ChatCompletionCreateParamsNonStreaming) {
	return {
		...params,
		thinking: {
			type: 'disabled'
		}
	} as ChatCompletionCreateParamsNonStreaming;
}

export function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel('English Learning Plugin');
	enlearnDiagnosticCollection = vscode.languages.createDiagnosticCollection('english-learning-plugin');
	const sidebarProvider = new EnglishLearningSidebarProvider(context.extensionUri);
	context.subscriptions.push(outputChannel);
	context.subscriptions.push(enlearnDiagnosticCollection);
	context.subscriptions.push(vscode.window.registerWebviewViewProvider('englishLearning.actionsView', sidebarProvider));

	context.subscriptions.push(
		vscode.commands.registerCommand('englishLearning.translateSelection', () => runLearningCommand(context, 'translate')),
		vscode.commands.registerCommand('englishLearning.explainSelection', () => runLearningCommand(context, 'explain')),
		vscode.commands.registerCommand('englishLearning.annotateSelection', () => runLearningCommand(context, 'annotate')),
		vscode.commands.registerCommand('englishLearning.insertEnlearnBlock', () => insertEnlearnBlock(context)),
		vscode.commands.registerCommand('englishLearning.summarizeLearningContent', () => summarizeLearningContent(context)),
		vscode.commands.registerCommand('englishLearning.practiceOrGradeSelection', () => practiceOrGradeSelection(context)),
		vscode.commands.registerCommand('englishLearning.generateRelatedWords', () => generateRelatedWords(context, sidebarProvider)),
		vscode.commands.registerCommand('englishLearning.insertRelatedWord', (item?: RelatedWord) => insertRelatedWord(item)),
		vscode.commands.registerCommand('englishLearning.playSelectionAudio', () => playSelectionAudio(context)),
		vscode.commands.registerCommand('englishLearning.setApiKey', () => setDeepSeekApiKey(context))
	);

	context.subscriptions.push(
		vscode.languages.registerInlineCompletionItemProvider({ language: ENLEARN_LANGUAGE_ID }, {
			provideInlineCompletionItems: (document, position, inlineContext, token) => provideEnlearnInlineCompletions(context, document, position, inlineContext, token)
		}),
		vscode.languages.registerHoverProvider({ language: ENLEARN_LANGUAGE_ID }, {
			provideHover: (document, position) => providePredictionHover(document, position)
		}),
		vscode.window.onDidChangeActiveTextEditor(editor => updateEnglishWordHighlights(editor)),
		vscode.window.onDidChangeVisibleTextEditors(() => updateAllVisibleEnglishWordHighlights()),
		vscode.workspace.onDidChangeTextDocument(event => {
			if (!isEnlearnDocument(event.document)) {
				return;
			}

			updateEnglishWordHighlightsForDocument(event.document);
			validateEnlearnLocalDocument(event.document);
			markChangedValidationSegments(event.document);
			scheduleEnlearnValidation(context, event.document);
		}),
		vscode.workspace.onDidSaveTextDocument(document => {
			if (isEnlearnDocument(document)) {
				void validateEnlearnDocument(context, document, true);
			}
		}),
		vscode.workspace.onDidOpenTextDocument(document => {
			if (isEnlearnDocument(document)) {
				initializeValidationSegmentSnapshot(document);
				void validateEnlearnDocument(context, document, false);
			}
		}),
		vscode.workspace.onDidCloseTextDocument(document => {
			const key = document.uri.toString();
			const timer = validationTimers.get(key);
			if (timer) {
				clearTimeout(timer);
			}
			validationTimers.delete(key);
			validationSegmentSnapshots.delete(key);
			dirtyValidationSegmentHashes.delete(key);
			aiValidationCaches.delete(key);
			enlearnDiagnosticCollection.delete(document.uri);
		}),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('englishLearning.highlight')) {
				refreshTextDecorations();
				updateAllVisibleEnglishWordHighlights();
			}

			if (event.affectsConfiguration('englishLearning.validation')) {
				for (const document of vscode.workspace.textDocuments) {
					if (isEnlearnDocument(document)) {
						initializeValidationSegmentSnapshot(document);
						void validateEnlearnDocument(context, document, false);
					}
				}
			}

			if (event.affectsConfiguration('englishLearning.prediction')) {
				predictionCache.clear();
				latestPrediction = undefined;
			}
		}),
		{
			dispose: () => {
				for (const timer of validationTimers.values()) {
					clearTimeout(timer);
				}
				validationTimers.clear();
				englishWordDecorationType?.dispose();
				chineseTextDecorationType?.dispose();
				questionLineDecorationType?.dispose();
				feedbackLineDecorationType?.dispose();
				commentTextDecorationType?.dispose();
				predictionCache.clear();
				latestPrediction = undefined;
				stopActiveAudioPlayback();
			}
		}
	);

	refreshTextDecorations();
	updateAllVisibleEnglishWordHighlights();
	for (const document of vscode.workspace.textDocuments) {
		if (isEnlearnDocument(document)) {
			initializeValidationSegmentSnapshot(document);
			void validateEnlearnDocument(context, document, false);
		}
	}

	return {
		setDeepSeekTestOverrides
	};
}

export function deactivate() {}

export function setDeepSeekTestOverrides(overrides?: {
	apiKey?: string;
	requester?: DeepSeekRequester;
}) {
	testDeepSeekApiKey = overrides?.apiKey;
	testDeepSeekRequester = overrides?.requester;
}

type EnglishLearningSidebarMessage = {
	type?: string;
	actionId?: string;
	relatedIndex?: number;
};

export const SIDEBAR_KEY_ICON_SIZE_PX = 48;
export const SIDEBAR_ACTION_ICON_SIZE_PX = 40;

class EnglishLearningSidebarProvider implements vscode.WebviewViewProvider {
	private webviewView: vscode.WebviewView | undefined;
	private relatedWordsResult: RelatedWordsResult | undefined;

	constructor(private readonly extensionUri: vscode.Uri) {}

	resolveWebviewView(webviewView: vscode.WebviewView) {
		this.webviewView = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'resources')]
		};
		webviewView.webview.onDidReceiveMessage(message => {
			void this.handleMessage(message);
		});
		this.refresh();
	}

	setRelatedWordsResult(result: RelatedWordsResult) {
		this.relatedWordsResult = result;
		this.refresh();
	}

	private refresh() {
		if (!this.webviewView) {
			return;
		}

		this.webviewView.webview.html = renderEnglishLearningSidebarHtml(
			this.webviewView.webview,
			this.extensionUri,
			ENGLISH_LEARNING_ACTIONS,
			this.relatedWordsResult
		);
	}

	private async handleMessage(message: EnglishLearningSidebarMessage) {
		if (!message || typeof message !== 'object') {
			return;
		}

		if (message.type === 'runAction' && typeof message.actionId === 'string') {
			const action = ENGLISH_LEARNING_ACTIONS.find(item => item.id === message.actionId);
			if (action) {
				await vscode.commands.executeCommand(action.command);
			}
			return;
		}

		if (message.type === 'insertRelatedWord' && typeof message.relatedIndex === 'number') {
			const word = this.relatedWordsResult?.words[message.relatedIndex];
			if (word) {
				await vscode.commands.executeCommand('englishLearning.insertRelatedWord', word);
			}
		}
	}
}

export function renderEnglishLearningSidebarHtml(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
	actions: EnglishLearningAction[],
	relatedWordsResult?: RelatedWordsResult
) {
	const nonce = createNonce();
	const actionCards = actions.map(action => renderSidebarAction(webview, extensionUri, action)).join('');
	const relatedWords = relatedWordsResult ? renderRelatedWordsSection(relatedWordsResult) : '';

	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style nonce="${nonce}">
		:root {
			color-scheme: light dark;
		}

		body {
			box-sizing: border-box;
			margin: 0;
			padding: 8px;
			color: var(--vscode-foreground);
			background: var(--vscode-sideBar-background);
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
		}

		.actions {
			display: flex;
			flex-direction: column;
			gap: 6px;
		}

		.action-card,
		.related-word {
			width: 100%;
			border: 1px solid transparent;
			border-radius: 10px;
			color: var(--vscode-foreground);
			background: transparent;
			text-align: left;
			cursor: pointer;
		}

		.action-card {
			display: grid;
			grid-template-columns: ${SIDEBAR_KEY_ICON_SIZE_PX + 4}px ${SIDEBAR_ACTION_ICON_SIZE_PX}px minmax(0, 1fr);
			align-items: center;
			gap: 8px;
			min-height: ${Math.max(SIDEBAR_KEY_ICON_SIZE_PX, SIDEBAR_ACTION_ICON_SIZE_PX) + 10}px;
			padding: 5px 6px;
		}

		.action-card:hover,
		.related-word:hover {
			border-color: var(--vscode-focusBorder);
			background: var(--vscode-list-hoverBackground);
		}

		.action-card:focus,
		.related-word:focus {
			outline: 1px solid var(--vscode-focusBorder);
			outline-offset: 2px;
		}

		.action-icon {
			display: block;
			width: ${SIDEBAR_KEY_ICON_SIZE_PX}px;
			height: ${SIDEBAR_KEY_ICON_SIZE_PX}px;
			object-fit: contain;
		}

		.action-feature-icon {
			display: block;
			width: ${SIDEBAR_ACTION_ICON_SIZE_PX}px;
			height: ${SIDEBAR_ACTION_ICON_SIZE_PX}px;
			object-fit: contain;
			justify-self: center;
		}

		.action-label {
			display: block;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			font-size: 14px;
			font-weight: 600;
			line-height: 1.4;
		}

		.action-meta {
			display: block;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			margin-top: 2px;
			color: var(--vscode-descriptionForeground);
			font-size: 12px;
			line-height: 1.35;
		}

		.action-text {
			min-width: 0;
		}

		.related-section {
			margin-top: 16px;
			padding-top: 12px;
			border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
		}

		.related-title {
			margin: 0 0 8px;
			color: var(--vscode-sideBarTitle-foreground);
			font-size: 13px;
			font-weight: 700;
		}

		.related-list {
			display: flex;
			flex-direction: column;
			gap: 6px;
		}

		.related-word {
			padding: 8px 10px;
		}

		.related-word-main {
			font-weight: 700;
		}

		.related-word-meta {
			margin-top: 2px;
			color: var(--vscode-descriptionForeground);
			font-size: 12px;
		}
	</style>
</head>
<body>
	<div class="actions" aria-label="英语学习快捷操作">
		${actionCards}
	</div>
	${relatedWords}
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		document.addEventListener('click', event => {
			const actionButton = event.target.closest('[data-action-id]');
			if (actionButton) {
				vscode.postMessage({ type: 'runAction', actionId: actionButton.dataset.actionId });
				return;
			}

			const relatedButton = event.target.closest('[data-related-index]');
			if (relatedButton) {
				vscode.postMessage({ type: 'insertRelatedWord', relatedIndex: Number(relatedButton.dataset.relatedIndex) });
			}
		});
	</script>
</body>
</html>`;
}

function renderSidebarAction(webview: vscode.Webview, extensionUri: vscode.Uri, action: EnglishLearningAction) {
	const iconUri = action.iconPath ? webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, action.iconPath)).toString() : '';
	const actionIconUri = action.actionIconPath ? webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, action.actionIconPath)).toString() : '';
	const status = action.requiresSelection ? '需选中' : '可直接用';
	const alt = `${action.shortcut} ${action.label}`;
	const icon = iconUri
		? `<img class="action-icon" src="${escapeHtmlAttribute(iconUri)}" alt="${escapeHtmlAttribute(alt)}">`
		: `<span class="action-icon" aria-hidden="true"></span>`;
	const actionIcon = actionIconUri
		? `<img class="action-feature-icon" src="${escapeHtmlAttribute(actionIconUri)}" alt="${escapeHtmlAttribute(action.label)} 功能图标">`
		: `<span class="action-feature-icon" aria-hidden="true"></span>`;

	return `<button class="action-card" type="button" data-action-id="${escapeHtmlAttribute(action.id)}" title="${escapeHtmlAttribute(`${action.label}\n${action.shortcut} · ${status}`)}">
		${icon}
		${actionIcon}
		<span class="action-text">
			<span class="action-label">${escapeHtml(action.label)}</span>
			<span class="action-meta">${escapeHtml(action.shortcut)} · ${escapeHtml(status)}</span>
		</span>
	</button>`;
}

function renderRelatedWordsSection(result: RelatedWordsResult) {
	const words = result.words.map((word, index) => {
		const meta = [word.domain, word.example].filter(Boolean).join(' · ');
		return `<button class="related-word" type="button" data-related-index="${index}" title="${escapeHtmlAttribute(word.note ?? '')}">
			<div class="related-word-main">${escapeHtml(word.word)} - ${escapeHtml(word.meaning)}</div>
			${meta ? `<div class="related-word-meta">${escapeHtml(meta)}</div>` : ''}
		</button>`;
	}).join('');

	return `<section class="related-section" aria-label="相关词">
		<h2 class="related-title">相关词：${escapeHtml(result.source)}（点击插入）</h2>
		<div class="related-list">${words}</div>
	</section>`;
}

function createNonce() {
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let index = 0; index < 32; index += 1) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

function escapeHtml(value: string) {
	return value.replace(/[&<>"']/g, character => {
		switch (character) {
			case '&':
				return '&amp;';
			case '<':
				return '&lt;';
			case '>':
				return '&gt;';
			case '"':
				return '&quot;';
			default:
				return '&#39;';
		}
	});
}

function escapeHtmlAttribute(value: string) {
	return escapeHtml(value);
}

async function provideEnlearnInlineCompletions(
	context: vscode.ExtensionContext,
	document: vscode.TextDocument,
	position: vscode.Position,
	_inlineContext: vscode.InlineCompletionContext,
	token: vscode.CancellationToken
): Promise<vscode.InlineCompletionItem[]> {
	if (!isEnlearnDocument(document) || !vscode.workspace.getConfiguration('englishLearning.prediction').get<boolean>('enabled', true)) {
		return [];
	}

	const lineTextBeforeCursor = document.lineAt(position.line).text.slice(0, position.character);
	if (!shouldTriggerPrediction(lineTextBeforeCursor)) {
		return [];
	}

	const predictionConfig = vscode.workspace.getConfiguration('englishLearning.prediction');
	const debounceMs = predictionConfig.get<number>('debounceMs', 800);
	await delayWithCancellation(debounceMs, token);
	if (token.isCancellationRequested) {
		return [];
	}

	const apiKey = await context.secrets.get(DEEPSEEK_SECRET_KEY);
	if (!apiKey) {
		return [];
	}

	const maxContextChars = predictionConfig.get<number>('maxContextChars', 1200);
	const cacheKey = createPredictionCacheKey(document, position, lineTextBeforeCursor, maxContextChars);
	const cached = predictionCache.get(cacheKey);
	if (cached) {
		latestPrediction = cached;
		return [new vscode.InlineCompletionItem(cached.completion, cached.insertRange)];
	}

	try {
		const result = await requestDeepSeekPrediction(apiKey, document, position, maxContextChars);
		if (!result || token.isCancellationRequested) {
			return [];
		}

		const insertRange = new vscode.Range(position, position);
		const hoverRange = new vscode.Range(
			position.line,
			Math.max(0, position.character - 1),
			position.line,
			position.character
		);
		const entry: PredictionCacheEntry = {
			key: cacheKey,
			completion: result.completion,
			translation: result.translation,
			insertRange,
			hoverRange
		};
		predictionCache.set(cacheKey, entry);
		latestPrediction = entry;
		return [new vscode.InlineCompletionItem(result.completion, insertRange)];
	} catch (error) {
		outputChannel.appendLine(`[${new Date().toISOString()}] Prediction failed: ${readErrorMessage(error) ?? String(error)}`);
		return [];
	}
}

function providePredictionHover(document: vscode.TextDocument, position: vscode.Position) {
	if (!isEnlearnDocument(document) || !vscode.workspace.getConfiguration('englishLearning.prediction').get<boolean>('showTranslationHover', true)) {
		return undefined;
	}

	if (!latestPrediction || !isNearPredictionRange(position, latestPrediction.hoverRange)) {
		return undefined;
	}

	const markdown = new vscode.MarkdownString();
	markdown.appendMarkdown('**中文翻译**\n\n');
	markdown.appendMarkdown(latestPrediction.translation);
	return new vscode.Hover(markdown, latestPrediction.hoverRange);
}

async function requestDeepSeekPrediction(
	apiKey: string,
	document: vscode.TextDocument,
	position: vscode.Position,
	maxContextChars: number
): Promise<EnlearnPredictionResult | undefined> {
	const contextText = buildPredictionContext(document.getText(), {
		line: position.line,
		character: position.character
	}, maxContextChars);
	const options = getDeepSeekOptions();
	const client = new OpenAI({
		apiKey,
		baseURL: options.baseUrl
	});

	const completion = await client.chat.completions.create(withDeepSeekNonThinking({
		model: options.model,
		temperature: 0.4,
		response_format: { type: 'json_object' },
		messages: [
			{
				role: 'system',
				content: `You predict concise natural English continuations for Chinese-speaking learners. Respond only with valid json. ${ASCII_PUNCTUATION_PROMPT_RULE}`
			},
			{
				role: 'user',
				content: `Continue the English writing at the cursor in this .enlearn note.

Rules:
- Return exactly one concise English continuation, one phrase or one sentence.
- Do not include Chinese in "completion".
- Provide a Chinese translation in "translation".
- Do not repeat the text already typed before the cursor.
- Do not add markdown fences.
- ${ASCII_PUNCTUATION_PROMPT_RULE}

Return valid json only:
{
  "completion": "the predicted English continuation",
  "translation": "对应中文翻译"
}

The word "json" is intentionally included because the API JSON mode requires it.

Context before cursor:
${contextText}`
			}
		]
	}));

	const content = completion.choices[0]?.message?.content;
	return content ? parsePredictionResult(content) : undefined;
}

function createPredictionCacheKey(document: vscode.TextDocument, position: vscode.Position, lineTextBeforeCursor: string, maxContextChars: number) {
	return [
		document.uri.toString(),
		document.version,
		position.line,
		position.character,
		maxContextChars,
		lineTextBeforeCursor
	].join('|');
}

function isNearPredictionRange(position: vscode.Position, range: vscode.Range) {
	return position.line === range.start.line && Math.abs(position.character - range.start.character) <= 2;
}

function delayWithCancellation(ms: number, token: vscode.CancellationToken) {
	if (ms <= 0 || token.isCancellationRequested) {
		return Promise.resolve();
	}

	return new Promise<void>(resolve => {
		let disposable: vscode.Disposable | undefined;
		const finish = () => {
			disposable?.dispose();
			resolve();
		};
		const timer = setTimeout(finish, ms);
		disposable = token.onCancellationRequested(() => {
			clearTimeout(timer);
			finish();
		});
	});
}

function isEnlearnDocument(document: vscode.TextDocument) {
	return document.languageId === ENLEARN_LANGUAGE_ID;
}

function refreshTextDecorations() {
	englishWordDecorationType?.dispose();
	chineseTextDecorationType?.dispose();
	questionLineDecorationType?.dispose();
	feedbackLineDecorationType?.dispose();
	commentTextDecorationType?.dispose();

	const englishConfig = vscode.workspace.getConfiguration('englishLearning.highlight.englishWords');
	const englishColor = englishConfig.get<string>('color')?.trim() || '#2F80ED';
	englishWordDecorationType = vscode.window.createTextEditorDecorationType({
		color: englishColor,
		fontWeight: '600'
	});

	const chineseConfig = vscode.workspace.getConfiguration('englishLearning.highlight.chineseText');
	const chineseColor = chineseConfig.get<string>('color')?.trim() || '#F2994A';
	chineseTextDecorationType = vscode.window.createTextEditorDecorationType({
		color: chineseColor,
		fontWeight: '600'
	});

	const questionConfig = vscode.workspace.getConfiguration('englishLearning.highlight.questionLine');
	const questionColor = questionConfig.get<string>('color')?.trim() || '#56CCF2';
	questionLineDecorationType = vscode.window.createTextEditorDecorationType({
		color: questionColor,
		fontWeight: '600'
	});

	const feedbackConfig = vscode.workspace.getConfiguration('englishLearning.highlight.feedbackLine');
	const feedbackColor = feedbackConfig.get<string>('color')?.trim() || '#F2C94C';
	feedbackLineDecorationType = vscode.window.createTextEditorDecorationType({
		color: feedbackColor,
		fontWeight: '600'
	});

	const commentConfig = vscode.workspace.getConfiguration('englishLearning.highlight.commentText');
	const commentColor = commentConfig.get<string>('color')?.trim() || '#8A8A8A';
	commentTextDecorationType = vscode.window.createTextEditorDecorationType({
		color: commentColor,
		fontStyle: 'italic'
	});
}

function updateAllVisibleEnglishWordHighlights() {
	for (const editor of vscode.window.visibleTextEditors) {
		updateEnglishWordHighlights(editor);
	}
}

function updateEnglishWordHighlightsForDocument(document: vscode.TextDocument) {
	for (const editor of vscode.window.visibleTextEditors) {
		if (editor.document.uri.toString() === document.uri.toString()) {
			updateEnglishWordHighlights(editor);
		}
	}
}

function updateEnglishWordHighlights(editor: vscode.TextEditor | undefined) {
	if (!editor || !englishWordDecorationType || !chineseTextDecorationType || !questionLineDecorationType || !feedbackLineDecorationType || !commentTextDecorationType) {
		return;
	}

	const englishEnabled = vscode.workspace.getConfiguration('englishLearning.highlight.englishWords').get<boolean>('enabled', true);
	const chineseEnabled = vscode.workspace.getConfiguration('englishLearning.highlight.chineseText').get<boolean>('enabled', true);
	const questionEnabled = vscode.workspace.getConfiguration('englishLearning.highlight.questionLine').get<boolean>('enabled', true);
	const feedbackEnabled = vscode.workspace.getConfiguration('englishLearning.highlight.feedbackLine').get<boolean>('enabled', true);
	const commentEnabled = vscode.workspace.getConfiguration('englishLearning.highlight.commentText').get<boolean>('enabled', true);
	if (!isEnlearnDocument(editor.document)) {
		editor.setDecorations(englishWordDecorationType, []);
		editor.setDecorations(chineseTextDecorationType, []);
		editor.setDecorations(questionLineDecorationType, []);
		editor.setDecorations(feedbackLineDecorationType, []);
		editor.setDecorations(commentTextDecorationType, []);
		return;
	}

	const text = editor.document.getText();
	const commentMatches = commentEnabled ? findCommentText(text) : [];
	const questionMatches = questionEnabled ? findQuestionLines(text) : [];
	const feedbackMatches = feedbackEnabled ? findFeedbackLines(text) : [];
	const semanticLineMatches = [...questionMatches, ...feedbackMatches];
	const englishRanges = englishEnabled ? findEnglishWords(text)
		.filter(match => !overlapsCommentText(match, commentMatches))
		.filter(match => !overlapsCommentText(match, semanticLineMatches))
		.map(match => new vscode.Range(
			match.line,
			match.startCharacter,
			match.line,
			match.endCharacter
		)) : [];
	const chineseRanges = chineseEnabled ? findChineseText(text)
		.filter(match => !overlapsCommentText(match, commentMatches))
		.filter(match => !overlapsCommentText(match, semanticLineMatches))
		.map(match => new vscode.Range(
			match.line,
			match.startCharacter,
			match.line,
			match.endCharacter
		)) : [];
	const questionRanges = questionMatches.map(match => new vscode.Range(
		match.line,
		match.startCharacter,
		match.line,
		match.endCharacter
	));
	const feedbackRanges = feedbackMatches.map(match => new vscode.Range(
		match.line,
		match.startCharacter,
		match.line,
		match.endCharacter
	));
	const commentRanges = commentMatches.map(match => new vscode.Range(
		match.line,
		match.startCharacter,
		match.line,
		match.endCharacter
	));
	editor.setDecorations(englishWordDecorationType, englishRanges);
	editor.setDecorations(chineseTextDecorationType, chineseRanges);
	editor.setDecorations(questionLineDecorationType, questionRanges);
	editor.setDecorations(feedbackLineDecorationType, feedbackRanges);
	editor.setDecorations(commentTextDecorationType, commentRanges);
}

function overlapsCommentText(
	match: { line: number; startCharacter: number; endCharacter: number },
	commentMatches: Array<{ line: number; startCharacter: number; endCharacter: number }>
) {
	return commentMatches.some(comment =>
		comment.line === match.line &&
		match.startCharacter < comment.endCharacter &&
		match.endCharacter > comment.startCharacter
	);
}

function scheduleEnlearnValidation(context: vscode.ExtensionContext, document: vscode.TextDocument) {
	const validationConfig = vscode.workspace.getConfiguration('englishLearning.validation');
	if (!validationConfig.get<boolean>('enabled', true)) {
		enlearnDiagnosticCollection.delete(document.uri);
		return;
	}

	const key = document.uri.toString();
	const existing = validationTimers.get(key);
	if (existing) {
		clearTimeout(existing);
	}

	const debounceMs = validationConfig.get<number>('debounceMs', 1500);
	const timer = setTimeout(() => {
		validationTimers.delete(key);
		void validateEnlearnDocument(context, document, true);
	}, debounceMs);

	validationTimers.set(key, timer);
}

function validateEnlearnLocalDocument(document: vscode.TextDocument) {
	if (!isEnlearnDocument(document) || !vscode.workspace.getConfiguration('englishLearning.validation').get<boolean>('enabled', true)) {
		enlearnDiagnosticCollection.delete(document.uri);
		return;
	}

	enlearnDiagnosticCollection.set(document.uri, toDiagnostics(document, validateEnlearnFormatText(document.getText())));
}

async function validateEnlearnDocument(context: vscode.ExtensionContext, document: vscode.TextDocument, includeAi: boolean) {
	if (!isEnlearnDocument(document) || !vscode.workspace.getConfiguration('englishLearning.validation').get<boolean>('enabled', true)) {
		enlearnDiagnosticCollection.delete(document.uri);
		return;
	}

	const version = document.version;
	const text = document.getText();
	const issues = validateEnlearnFormatText(text);
	const segments = extractCheckableEnglishSegments(text);
	pruneAiValidationCache(document, segments);
	const aiValidationEnabled = vscode.workspace.getConfiguration('englishLearning.validation.ai').get<boolean>('enabled', true);

	if (includeAi && aiValidationEnabled) {
		const apiKey = await context.secrets.get(DEEPSEEK_SECRET_KEY);
		if (!apiKey) {
			void showMissingValidationApiKeyNotice();
		} else {
			try {
				const dirtySegments = getDirtyValidationSegments(document, segments);
				if (dirtySegments.length > 0) {
					await refreshAiValidationCache(document, apiKey, dirtySegments);
				}
			} catch (error) {
				outputChannel.appendLine(`[${new Date().toISOString()}] AI validation failed: ${readErrorMessage(error) ?? String(error)}`);
			}
		}
	}

	if (document.version !== version) {
		return;
	}

	if (aiValidationEnabled) {
		issues.push(...readCachedAiValidationIssues(document, segments));
	}
	enlearnDiagnosticCollection.set(document.uri, toDiagnostics(document, issues));
}

function initializeValidationSegmentSnapshot(document: vscode.TextDocument) {
	const key = document.uri.toString();
	const hashes = new Set(extractCheckableEnglishSegments(document.getText()).map(segment => segment.hash));
	validationSegmentSnapshots.set(key, hashes);
	dirtyValidationSegmentHashes.set(key, new Set());
}

function markChangedValidationSegments(document: vscode.TextDocument) {
	const key = document.uri.toString();
	const previousHashes = validationSegmentSnapshots.get(key) ?? new Set<string>();
	const currentHashes = new Set(extractCheckableEnglishSegments(document.getText()).map(segment => segment.hash));
	const dirtyHashes = dirtyValidationSegmentHashes.get(key) ?? new Set<string>();

	for (const hash of currentHashes) {
		if (!previousHashes.has(hash)) {
			dirtyHashes.add(hash);
		}
	}

	for (const hash of [...dirtyHashes]) {
		if (!currentHashes.has(hash)) {
			dirtyHashes.delete(hash);
		}
	}

	validationSegmentSnapshots.set(key, currentHashes);
	dirtyValidationSegmentHashes.set(key, dirtyHashes);
}

function getDirtyValidationSegments(document: vscode.TextDocument, segments: EnlearnCheckableSegment[]) {
	const dirtyHashes = dirtyValidationSegmentHashes.get(document.uri.toString());
	if (!dirtyHashes || dirtyHashes.size === 0) {
		return [];
	}

	const seen = new Set<string>();
	return segments.filter(segment => {
		if (!dirtyHashes.has(segment.hash) || seen.has(segment.hash)) {
			return false;
		}

		seen.add(segment.hash);
		return true;
	});
}

function pruneAiValidationCache(document: vscode.TextDocument, segments: EnlearnCheckableSegment[]) {
	const cache = aiValidationCaches.get(document.uri.toString());
	if (!cache) {
		return;
	}

	const currentHashes = new Set(segments.map(segment => segment.hash));
	for (const hash of cache.keys()) {
		if (!currentHashes.has(hash)) {
			cache.delete(hash);
		}
	}
}

async function refreshAiValidationCache(document: vscode.TextDocument, apiKey: string, segments: EnlearnCheckableSegment[]) {
	const key = document.uri.toString();
	const issues = await requestDeepSeekValidationIssues(apiKey, segments);
	const issuesBySegmentId = groupIssuesBySegmentId(issues);
	const cache = aiValidationCaches.get(key) ?? new Map<string, AiValidationCacheEntry>();
	const dirtyHashes = dirtyValidationSegmentHashes.get(key) ?? new Set<string>();

	for (const segment of segments) {
		cache.set(segment.hash, {
			text: segment.text,
			issues: (issuesBySegmentId.get(segment.id) ?? []).map(stripIssueRange)
		});
		dirtyHashes.delete(segment.hash);
	}

	aiValidationCaches.set(key, cache);
	dirtyValidationSegmentHashes.set(key, dirtyHashes);
}

function readCachedAiValidationIssues(document: vscode.TextDocument, segments: EnlearnCheckableSegment[]) {
	const cache = aiValidationCaches.get(document.uri.toString());
	if (!cache) {
		return [];
	}

	return segments.flatMap(segment => {
		const entry = cache.get(segment.hash);
		if (!entry || entry.text !== segment.text) {
			return [];
		}

		return entry.issues.map(issue => localizeAiIssue(segment, issue));
	});
}

function groupIssuesBySegmentId(issues: EnlearnValidationIssue[]) {
	const grouped = new Map<string, EnlearnValidationIssue[]>();
	for (const issue of issues) {
		if (!issue.segmentId) {
			continue;
		}

		const existing = grouped.get(issue.segmentId) ?? [];
		existing.push(issue);
		grouped.set(issue.segmentId, existing);
	}

	return grouped;
}

function stripIssueRange(issue: EnlearnValidationIssue): EnlearnValidationIssue {
	return {
		kind: issue.kind,
		message: issue.message,
		severity: issue.severity,
		text: issue.text,
		suggestion: issue.suggestion,
		segmentId: issue.segmentId
	};
}

function localizeAiIssue(segment: EnlearnCheckableSegment, issue: EnlearnValidationIssue): EnlearnValidationIssue {
	const text = issue.text?.trim();
	if (text) {
		const index = segment.text.indexOf(text);
		if (index >= 0) {
			return {
				...issue,
				segmentId: segment.id,
				range: {
					line: segment.range.line,
					startCharacter: segment.range.startCharacter + index,
					endCharacter: segment.range.startCharacter + index + text.length
				}
			};
		}
	}

	return {
		...issue,
		segmentId: segment.id,
		range: segment.range
	};
}

async function showMissingValidationApiKeyNotice() {
	if (missingValidationApiKeyNoticeShown) {
		return;
	}

	missingValidationApiKeyNoticeShown = true;
	const action = await vscode.window.showInformationMessage(
		'DeepSeek API key is not set. .enlearn local format diagnostics are active; set a key to enable AI spelling and grammar diagnostics.',
		'Set API Key'
	);

	if (action === 'Set API Key') {
		await vscode.commands.executeCommand('englishLearning.setApiKey');
	}
}

async function requestDeepSeekValidationIssues(apiKey: string, segments: EnlearnCheckableSegment[]): Promise<EnlearnValidationIssue[]> {
	if (segments.length === 0) {
		return [];
	}

	const options = getDeepSeekOptions();
	const client = new OpenAI({
		apiKey,
		baseURL: options.baseUrl
	});

	const completion = await client.chat.completions.create(withDeepSeekNonThinking({
		model: options.model,
		temperature: 0,
		response_format: { type: 'json_object' },
		messages: [
			{
				role: 'system',
				content: `You are an English spelling, grammar, and usage checker for .enlearn study notes. Respond only with valid json. ${ASCII_PUNCTUATION_PROMPT_RULE}`
			},
			{
				role: 'user',
				content: `Check only these changed .enlearn English segments for spelling errors, grammar errors, wrong word usage, and unnatural expressions.

Do not infer or report issues outside the provided segments. Ignore cloze hints like {answer|hint}. Report only real English learning issues.

Return valid json only. Use this JSON shape:
{
  "issues": [
    {
      "segmentId": "segment id from input",
      "text": "wrong text",
      "kind": "spelling | grammar | usage",
      "message": "语法错误: explain the issue in Chinese",
      "suggestion": "correct text",
      "severity": "error | warning"
    }
  ]
}

The word "json" is intentionally included because the API JSON mode requires it.
${ASCII_PUNCTUATION_PROMPT_RULE}

Segments:
${JSON.stringify(segments.map(segment => ({
	id: segment.id,
	text: segment.text
})), null, 2)}`
			}
		]
	}));

	const content = completion.choices[0]?.message?.content;
	return content ? assignMissingSegmentIds(parseAiValidationIssues(content), segments) : [];
}

function assignMissingSegmentIds(issues: EnlearnValidationIssue[], segments: EnlearnCheckableSegment[]) {
	return issues.flatMap(issue => {
		if (issue.segmentId) {
			return [issue];
		}

		if (!issue.text) {
			return [];
		}

		const matchedSegment = segments.find(segment => segment.text.includes(issue.text ?? ''));
		return matchedSegment ? [{
			...issue,
			segmentId: matchedSegment.id
		}] : [];
	});
}

function toDiagnostics(document: vscode.TextDocument, issues: EnlearnValidationIssue[]) {
	return issues.map(issue => {
		const diagnostic = new vscode.Diagnostic(
			toIssueRange(document, issue),
			toDiagnosticMessage(issue),
			issue.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error
		);
		diagnostic.source = 'English Learning Plugin';
		diagnostic.code = issue.kind;
		return diagnostic;
	});
}

function toIssueRange(document: vscode.TextDocument, issue: EnlearnValidationIssue) {
	if (issue.range) {
		return new vscode.Range(
			issue.range.line,
			issue.range.startCharacter,
			issue.range.line,
			Math.max(issue.range.endCharacter, issue.range.startCharacter + 1)
		);
	}

	if (issue.text) {
		const index = document.getText().indexOf(issue.text);
		if (index >= 0) {
			return new vscode.Range(document.positionAt(index), document.positionAt(index + issue.text.length));
		}
	}

	const fallbackLine = findFirstNonEmptyLine(document);
	const line = document.lineAt(fallbackLine);
	return new vscode.Range(fallbackLine, 0, fallbackLine, Math.max(line.text.length, 1));
}

function findFirstNonEmptyLine(document: vscode.TextDocument) {
	for (let line = 0; line < document.lineCount; line++) {
		if (document.lineAt(line).text.trim().length > 0) {
			return line;
		}
	}

	return 0;
}

function toDiagnosticMessage(issue: EnlearnValidationIssue) {
	const label = {
		spelling: '拼写错误',
		grammar: '语法错误',
		usage: '表达不自然',
		format: '格式错误'
	}[issue.kind];
	const message = issue.message.startsWith(label) ? issue.message : `${label}: ${issue.message}`;
	return issue.suggestion ? `${message}\n建议: ${issue.suggestion}` : message;
}

async function runLearningCommand(context: vscode.ExtensionContext, mode: Exclude<LearningMode, 'enlearn' | 'summarize'>) {
	const selected = getSelectedText();
	if (!selected) {
		return;
	}

	const apiKey = await getDeepSeekApiKeyOrPrompt(context);
	if (!apiKey) {
		return;
	}

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: getProgressTitle(mode),
		cancellable: false
	}, async () => {
		try {
			const contextExplanation = mode === 'explain' ? getSelectionSentenceContext(selected.editor) : undefined;
			const inlineTranslation = mode === 'translate' ? getInlineTranslationTarget(selected.editor) : undefined;
			const response = await requestDeepSeek(
				apiKey,
				mode === 'explain' ? 'contextExplain' : inlineTranslation ? 'contextTranslate' : mode,
				contextExplanation
					? buildContextExplainInput(selected.text, contextExplanation.text)
					: inlineTranslation
						? buildContextTranslateInput(selected.text, inlineTranslation.contextText)
						: selected.text
			);
			const content = mode === 'annotate'
				? toEnlearnBlock(selected.text, response.result, response.options.model)
				: toMarkdown(mode, selected.text, response.result, response.options.model);

			await saveLearningRecord(context, {
				id: createRecordId(),
				mode,
				sourceText: selected.text,
				translation: response.result.translation,
				explanation: response.result.explanation ?? response.result.summary,
				annotation: mode === 'annotate' ? content : undefined,
				sourceUri: selected.sourceUri,
				timestamp: new Date().toISOString(),
				direction: response.result.direction,
				model: response.options.model
			});

			if (mode === 'translate') {
				if (inlineTranslation) {
					await insertInlineTranslation(selected.editor, inlineTranslation.insertPosition, response.result.translation);
				} else {
					await insertTranslationBelowSelection(selected.editor, response.result.translation);
				}
				return;
			}

			if (mode === 'explain') {
				if (contextExplanation) {
					await insertPsExplanationAfterSentence(selected.editor, contextExplanation.endLine, response.result.explanation ?? response.result.summary);
				}
				return;
			}

			if (mode === 'annotate') {
				await showEnlearnDocument(content);
			} else {
				await showMarkdownDocument(content);
			}
		} catch (error) {
			handleCommandError(error);
		}
	});
}

function getSelectionSentenceContext(editor: vscode.TextEditor) {
	const selection = editor.selection;
	const range: TextSelectionRange = {
		startLine: selection.start.line,
		startCharacter: selection.start.character,
		endLine: selection.end.line,
		endCharacter: selection.end.character
	};
	const lines = Array.from({ length: editor.document.lineCount }, (_, lineNumber) => ({
		lineNumber,
		text: editor.document.lineAt(lineNumber).text
	}));

	return collectSentenceContext(lines, range);
}

function getInlineTranslationTarget(editor: vscode.TextEditor): InlineTranslationTarget | undefined {
	if (editor.selections.length !== 1) {
		return undefined;
	}

	const selection = editor.selection;
	const rawText = editor.document.getText(selection);
	const selectedWord = rawText.trim();
	if (!isSingleEnglishWord(selectedWord)) {
		return undefined;
	}

	const context = getSelectionSentenceContext(editor);
	if (!context.text) {
		return undefined;
	}

	const leadingWhitespaceLength = rawText.length - rawText.trimStart().length;
	const trailingWhitespaceLength = rawText.length - rawText.trimEnd().length;
	const insertOffset = editor.document.offsetAt(selection.end) - trailingWhitespaceLength;

	return {
		contextText: context.text,
		insertPosition: editor.document.positionAt(Math.max(editor.document.offsetAt(selection.start) + leadingWhitespaceLength, insertOffset))
	};
}

function buildContextExplainInput(selectedText: string, sentenceContext: string) {
	return [
		`Selected text: ${selectedText}`,
		'',
		'Sentence context:',
		sentenceContext
	].join('\n');
}

function buildContextTranslateInput(selectedText: string, sentenceContext: string) {
	return [
		`Selected word: ${selectedText.trim()}`,
		'',
		'Sentence context:',
		sentenceContext
	].join('\n');
}

function buildGradePracticeInput(answerText: string, documentText: string) {
	return [
		'Learner answer:',
		answerText.trim(),
		'',
		'.enlearn learning content:',
		documentText.trim()
	].join('\n');
}

function buildGradePracticeBatchInput(items: PracticeBatchItem[], documentText: string) {
	return [
		'Practice items JSON:',
		JSON.stringify(items.map(item => ({
			id: item.id,
			question: item.question,
			answer: item.answer
		})), null, 2),
		'',
		'.enlearn learning content:',
		documentText.trim()
	].join('\n');
}

function toTextSelectionRange(selection: vscode.Selection): TextSelectionRange {
	return {
		startLine: selection.start.line,
		startCharacter: selection.start.character,
		endLine: selection.end.line,
		endCharacter: selection.end.character
	};
}

export function parsePracticeBatchItems(documentText: string, selections: TextSelectionRange[]): PracticeBatchItem[] {
	const lines = documentText.split(/\r?\n/);
	const drafts: Array<{
		question: string;
		startLine: number;
		endLine: number;
		answerLines: string[];
	}> = [];

	for (const selection of selections) {
		const startLine = Math.max(0, Math.min(selection.startLine, selection.endLine));
		const rawEndLine = selection.endCharacter === 0 && selection.endLine > selection.startLine
			? selection.endLine - 1
			: selection.endLine;
		const endLine = Math.min(lines.length - 1, Math.max(startLine, rawEndLine));
		let current: typeof drafts[number] | undefined;

		for (let line = startLine; line <= endLine; line++) {
			const value = lines[line] ?? '';
			const trimmedStart = value.trimStart();

			if (trimmedStart.startsWith('?')) {
				if (current) {
					drafts.push(current);
				}

				current = {
					question: value.trim(),
					startLine: line,
					endLine: line,
					answerLines: []
				};
				continue;
			}

			if (!current) {
				continue;
			}

			current.endLine = line;
			if (isPracticeAnswerLine(value)) {
				current.answerLines.push(value.trim());
			}
		}

		if (current) {
			drafts.push(current);
		}
	}

	return drafts.map((draft, index) => ({
		id: `item-${index + 1}`,
		question: draft.question,
		answer: draft.answerLines.join('\n').trim(),
		startLine: draft.startLine,
		endLine: draft.endLine
	}));
}

function isPracticeAnswerLine(value: string) {
	const trimmed = value.trim();
	if (!trimmed) {
		return false;
	}

	const trimmedStart = value.trimStart();
	return !trimmedStart.startsWith('?') && !trimmedStart.startsWith('!') && !trimmedStart.startsWith('//');
}

async function insertPsExplanationAfterSentence(editor: vscode.TextEditor, sentenceEndLine: number, explanation: string | undefined) {
	const value = formatPsExplanation(explanation ?? '');
	if (!value) {
		vscode.window.showWarningMessage('DeepSeek did not return a usable explanation.');
		return;
	}

	const safeLine = Math.min(sentenceEndLine, editor.document.lineCount - 1);
	const line = editor.document.lineAt(safeLine);
	await editor.edit(editBuilder => {
		editBuilder.insert(line.range.end, value);
	});
}

async function insertInlineTranslation(editor: vscode.TextEditor, position: vscode.Position, translation: string | undefined) {
	const value = formatInlineTranslation(translation ?? '');
	if (!value) {
		vscode.window.showWarningMessage('DeepSeek did not return a usable word translation.');
		return;
	}

	await editor.edit(editBuilder => {
		editBuilder.insert(position, value);
	});
}

async function insertTranslationBelowSelection(editor: vscode.TextEditor, translation: string | undefined) {
	const value = normalizeInsertedTranslation(translation ?? '');
	if (!value) {
		vscode.window.showWarningMessage('DeepSeek did not return translation text.');
		return;
	}

	const insertLine = getLineAfterSelections(editor.selections.map(selection => ({
		startLine: selection.start.line,
		startCharacter: selection.start.character,
		endLine: selection.end.line,
		endCharacter: selection.end.character
	})));
	await editor.edit(editBuilder => {
		if (insertLine >= editor.document.lineCount) {
			const lastLine = editor.document.lineAt(editor.document.lineCount - 1);
			editBuilder.insert(lastLine.range.end, `\n${value}`);
			return;
		}

		editBuilder.insert(new vscode.Position(insertLine, 0), `${value}\n`);
	});
}

async function insertTextBelowSelections(editor: vscode.TextEditor, text: string) {
	const value = text.trim();
	if (!value) {
		return;
	}

	const insertLine = getLineAfterSelections(editor.selections.map(selection => ({
		startLine: selection.start.line,
		startCharacter: selection.start.character,
		endLine: selection.end.line,
		endCharacter: selection.end.character
	})));

	await editor.edit(editBuilder => {
		if (insertLine >= editor.document.lineCount) {
			const lastLine = editor.document.lineAt(editor.document.lineCount - 1);
			editBuilder.insert(lastLine.range.end, `\n${value}`);
			return;
		}

		editBuilder.insert(new vscode.Position(insertLine, 0), `${value}\n`);
	});
}

async function insertPracticeBatchFeedbacks(editor: vscode.TextEditor, feedbacks: PracticeBatchFeedback[]) {
	const usableFeedbacks = feedbacks
		.filter(item => item.feedback.trim().length > 0)
		.sort((left, right) => left.item.endLine - right.item.endLine);
	if (usableFeedbacks.length === 0) {
		return;
	}

	await editor.edit(editBuilder => {
		for (const { item, feedback } of usableFeedbacks) {
			const value = feedback.trim();
			const insertLine = item.endLine + 1;
			if (insertLine >= editor.document.lineCount) {
				const lastLine = editor.document.lineAt(editor.document.lineCount - 1);
				editBuilder.insert(lastLine.range.end, `\n${value}`);
				continue;
			}

			editBuilder.insert(new vscode.Position(insertLine, 0), `${value}\n`);
		}
	});
}

async function appendTextToDocument(editor: vscode.TextEditor, text: string) {
	const value = text.trimEnd();
	if (!value) {
		return;
	}

	const fullText = editor.document.getText();
	const lastLine = editor.document.lineAt(editor.document.lineCount - 1);
	const prefix = fullText.length === 0 || fullText.endsWith('\n') ? '' : '\n';
	const separator = fullText.trim().length === 0 ? '' : '\n';
	await editor.edit(editBuilder => {
		editBuilder.insert(lastLine.range.end, `${prefix}${separator}${value}\n`);
	});
}

async function summarizeLearningContent(context: vscode.ExtensionContext) {
	const target = getSelectedTextOrCurrentDocument();
	if (!target) {
		return;
	}

	const apiKey = await getDeepSeekApiKeyOrPrompt(context);
	if (!apiKey) {
		return;
	}

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: 'English Learning Plugin: summarizing learning content',
		cancellable: false
	}, async () => {
		try {
			const response = await requestDeepSeek(apiKey, 'summarize', target.text);
			const content = toMarkdown('summarize', target.text, response.result, response.options.model);

			await saveLearningRecord(context, {
				id: createRecordId(),
				mode: 'summarize',
				sourceText: target.text,
				translation: response.result.translation,
				explanation: response.result.explanation ?? response.result.summary,
				annotation: content,
				sourceUri: target.sourceUri,
				timestamp: new Date().toISOString(),
				direction: response.result.direction,
				model: response.options.model
			});

			await showMarkdownDocument(content);
		} catch (error) {
			handleCommandError(error);
		}
	});
}

async function practiceOrGradeSelection(context: vscode.ExtensionContext) {
	const target = getPracticeOrGradeTarget();
	if (!target) {
		return;
	}

	const hasAnswer = target.selectedText.length > 0;
	const batchItems = hasAnswer ? parsePracticeBatchItems(target.editor.document.getText(), target.editor.selections.map(toTextSelectionRange)) : [];

	if (batchItems.length > 0) {
		await gradePracticeBatch(context, target, batchItems);
		return;
	}

	const apiKey = await getDeepSeekApiKeyOrPrompt(context);
	if (!apiKey) {
		return;
	}

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: hasAnswer ? 'English Learning Plugin: grading practice answer' : 'English Learning Plugin: generating practice questions',
		cancellable: false
	}, async () => {
		try {
			const response = await requestDeepSeek(
				apiKey,
				hasAnswer ? 'gradePractice' : 'practice',
				hasAnswer
					? buildGradePracticeInput(target.selectedText, target.documentText)
					: target.documentText
			);

			if (hasAnswer) {
				const feedback = formatPracticeGrading(response.result.grading);
				if (!feedback) {
					vscode.window.showWarningMessage('DeepSeek did not return usable grading feedback.');
					return;
				}

				await insertTextBelowSelections(target.editor, feedback);
				return;
			}

			const block = formatPracticeBlock(response.result.questions, new Date());
			if (!block) {
				vscode.window.showWarningMessage('DeepSeek did not return usable practice questions.');
				return;
			}

			await appendTextToDocument(target.editor, block);
		} catch (error) {
			handleCommandError(error);
		}
	});
}

async function gradePracticeBatch(context: vscode.ExtensionContext, target: PracticeOrGradeTarget, batchItems: PracticeBatchItem[]) {
	const answeredItems = batchItems.filter(item => item.answer.trim().length > 0);
	if (answeredItems.length === 0) {
		await insertPracticeBatchFeedbacks(target.editor, batchItems.map(item => ({
			item,
			feedback: formatUnansweredPracticeFeedback()
		})));
		return;
	}

	const apiKey = await getDeepSeekApiKeyOrPrompt(context);
	if (!apiKey) {
		return;
	}

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: `English Learning Plugin: grading ${batchItems.length} practice answers`,
		cancellable: false
	}, async () => {
		try {
			const response = await requestDeepSeek(apiKey, 'gradePracticeBatch', buildGradePracticeBatchInput(answeredItems, target.documentText));
			const gradingById = new Map(response.result.gradings.map(grading => [grading.id, grading]));
			const feedbacks = batchItems.map(item => {
				if (!item.answer.trim()) {
					return {
						item,
						feedback: formatUnansweredPracticeFeedback()
					};
				}

				return {
					item,
					feedback: formatPracticeGrading(gradingById.get(item.id)) || '! 批改: 无法批改. DeepSeek 未返回此题结果.'
				};
			});

			await insertPracticeBatchFeedbacks(target.editor, feedbacks);
		} catch (error) {
			handleCommandError(error);
		}
	});
}

async function insertEnlearnBlock(context: vscode.ExtensionContext) {
	const selected = getSelectedText();
	if (!selected) {
		return;
	}

	const apiKey = await getDeepSeekApiKeyOrPrompt(context);
	if (!apiKey) {
		return;
	}

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: 'English Learning Plugin: generating .enlearn block',
		cancellable: false
	}, async () => {
		try {
			const response = await requestDeepSeek(apiKey, 'enlearn', selected.text);
			const block = toEnlearnBlock(selected.text, response.result, response.options.model);

			await saveLearningRecord(context, {
				id: createRecordId(),
				mode: 'enlearn',
				sourceText: selected.text,
				translation: response.result.translation,
				explanation: response.result.explanation ?? response.result.summary,
				annotation: block,
				sourceUri: selected.sourceUri,
				timestamp: new Date().toISOString(),
				direction: response.result.direction,
				model: response.options.model
			});

			if (selected.editor.document.languageId === 'enlearn') {
				await selected.editor.edit(editBuilder => {
					editBuilder.replace(selected.editor.selection, `${block}\n`);
				});
				return;
			}

			await showEnlearnDocument(block);
		} catch (error) {
			handleCommandError(error);
		}
	});
}

async function generateRelatedWords(context: vscode.ExtensionContext, sidebarProvider: EnglishLearningSidebarProvider) {
	const target = getRelatedWordTarget();
	if (!target) {
		return;
	}

	const apiKey = await getDeepSeekApiKeyOrPrompt(context);
	if (!apiKey) {
		return;
	}

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: `English Learning Plugin: generating related words for "${target.word}"`,
		cancellable: false
	}, async () => {
		try {
			const result = await requestDeepSeekRelatedWords(apiKey, target.word);
			sidebarProvider.setRelatedWordsResult(result);
			vscode.window.showInformationMessage(`Generated ${result.words.length} related words for "${result.source}".`);
		} catch (error) {
			handleCommandError(error);
		}
	});
}

async function insertRelatedWord(item: RelatedWord | undefined) {
	if (!item) {
		vscode.window.showWarningMessage('Generate related words first, then click a word in the English Learning sidebar.');
		return;
	}

	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.document.languageId !== ENLEARN_LANGUAGE_ID) {
		vscode.window.showWarningMessage('Open a .enlearn editor before inserting a related word.');
		return;
	}

	const block = `${formatRelatedWordBlock(item)}\n`;
	await editor.edit(editBuilder => {
		if (editor.selection.isEmpty) {
			editBuilder.insert(editor.selection.active, block);
		} else {
			editBuilder.replace(editor.selection, block);
		}
	});
}

function getRelatedWordTarget(): RelatedWordTarget | undefined {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showWarningMessage('Open a .enlearn editor and place the cursor on an English word first.');
		return undefined;
	}

	if (editor.document.languageId !== ENLEARN_LANGUAGE_ID) {
		vscode.window.showWarningMessage('Related word generation is only active in .enlearn files.');
		return undefined;
	}

	const selectedText = editor.selections
		.map(selection => editor.document.getText(selection))
		.filter(value => value.trim().length > 0)
		.join('\n');
	const selectedWord = normalizeRelatedWordInput(selectedText);
	if (selectedWord) {
		return {
			editor,
			word: selectedWord,
			sourceUri: editor.document.uri.toString()
		};
	}

	const position = editor.selection.active;
	const lineText = editor.document.lineAt(position.line).text;
	const word = getEnglishWordAt(lineText, position.character);
	if (!word) {
		vscode.window.showWarningMessage('Select one English word, or place the cursor on an English word.');
		return undefined;
	}

	return {
		editor,
		word,
		sourceUri: editor.document.uri.toString()
	};
}

async function playSelectionAudio(context: vscode.ExtensionContext) {
	const target = getSelectedTtsText();
	if (!target) {
		return;
	}

	const settings = getTtsSettings();
	const validationError = validateTtsText(target, settings.maxTextLength);
	if (validationError) {
		vscode.window.showWarningMessage(toTtsValidationMessage(validationError, settings.maxTextLength));
		return;
	}

	stopActiveAudioPlayback();
	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: 'English Learning Plugin: playing pronunciation',
		cancellable: false
	}, async () => {
		let audioPath: string;
		try {
			audioPath = await generateTtsAudio(context, target, settings);
		} catch (error) {
			const message = `语音生成失败，请检查网络或稍后重试。${readErrorMessage(error) ? ` ${readErrorMessage(error)}` : ''}`;
			outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
			vscode.window.showErrorMessage(message);
			return;
		}

		try {
			await playAudioFile(audioPath);
		} catch (error) {
			const message = `语音播放失败。${readErrorMessage(error) ? ` ${readErrorMessage(error)}` : ''}`;
			outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
			vscode.window.showErrorMessage(message);
		}
	});
}

function getSelectedTtsText() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showWarningMessage('Open a .enlearn editor and select an English word or sentence first.');
		return undefined;
	}

	if (editor.document.languageId !== ENLEARN_LANGUAGE_ID) {
		vscode.window.showWarningMessage('Pronunciation playback is only active in .enlearn files.');
		return undefined;
	}

	return normalizeTtsText(editor.selections.map(selection => editor.document.getText(selection)));
}

function getTtsSettings(): TtsSettings {
	const config = vscode.workspace.getConfiguration('englishLearning.tts');

	return {
		voice: config.get<string>('voice')?.trim() || DEFAULT_TTS_SETTINGS.voice,
		lang: config.get<string>('lang')?.trim() || DEFAULT_TTS_SETTINGS.lang,
		rate: config.get<string>('rate')?.trim() || DEFAULT_TTS_SETTINGS.rate,
		pitch: config.get<string>('pitch')?.trim() || DEFAULT_TTS_SETTINGS.pitch,
		volume: config.get<string>('volume')?.trim() || DEFAULT_TTS_SETTINGS.volume,
		timeoutMs: config.get<number>('timeoutMs') ?? DEFAULT_TTS_SETTINGS.timeoutMs,
		maxTextLength: config.get<number>('maxTextLength') ?? DEFAULT_TTS_SETTINGS.maxTextLength
	};
}

async function generateTtsAudio(context: vscode.ExtensionContext, text: string, settings: TtsSettings) {
	const speechDirectory = vscode.Uri.joinPath(context.globalStorageUri, 'speech', 'cache');
	await vscode.workspace.fs.createDirectory(speechDirectory);
	const audioUri = vscode.Uri.joinPath(speechDirectory, `${createTtsCacheKey(text, settings)}.mp3`);
	if (await fileExists(audioUri)) {
		return audioUri.fsPath;
	}

	const tts = new EdgeTTS({
		voice: settings.voice,
		lang: settings.lang,
		outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
		rate: settings.rate,
		pitch: settings.pitch,
		volume: settings.volume,
		timeout: settings.timeoutMs
	});

	await tts.ttsPromise(text, audioUri.fsPath);
	return audioUri.fsPath;
}

async function fileExists(uri: vscode.Uri) {
	try {
		const stat = await vscode.workspace.fs.stat(uri);
		return stat.type === vscode.FileType.File && stat.size > 0;
	} catch {
		return false;
	}
}

function playAudioFile(audioPath: string) {
	return new Promise<void>((resolve, reject) => {
		const child = spawn('powershell.exe', [
			'-NoProfile',
			'-ExecutionPolicy',
			'Bypass',
			'-Command',
			buildPowerShellMediaPlayerScript(audioPath)
		], {
			windowsHide: true
		});
		activeAudioPlayback = child;
		let stderr = '';

		child.stderr?.on('data', chunk => {
			stderr += chunk.toString();
		});
		child.on('error', error => {
			if (activeAudioPlayback === child) {
				activeAudioPlayback = undefined;
			}
			reject(error);
		});
		child.on('close', code => {
			const isCurrentPlayback = activeAudioPlayback === child;
			if (isCurrentPlayback) {
				activeAudioPlayback = undefined;
			}

			if (!isCurrentPlayback || code === 0) {
				resolve();
				return;
			}

			reject(new Error(stderr.trim() || `PowerShell audio player exited with code ${code}.`));
		});
	});
}

function stopActiveAudioPlayback() {
	const child = activeAudioPlayback;
	activeAudioPlayback = undefined;
	if (child && !child.killed) {
		child.kill();
	}
}

async function requestDeepSeekRelatedWords(apiKey: string, word: string): Promise<RelatedWordsResult> {
	const options = getDeepSeekOptions();
	const client = new OpenAI({
		apiKey,
		baseURL: options.baseUrl
	});

	let content: string | null | undefined;
	try {
		const completion = await client.chat.completions.create(withDeepSeekNonThinking({
			model: options.model,
			temperature: 0.3,
			response_format: { type: 'json_object' },
			messages: [
				{
					role: 'system',
					content: `You generate concise English vocabulary study data for Chinese-speaking learners. Respond only with valid json. ${ASCII_PUNCTUATION_PROMPT_RULE}`
				},
				{
					role: 'user',
					content: `Generate exactly 5 English words from fields closely related to the source word.

Rules:
- Use words in a similar topic, usage domain, or collocation field.
- Avoid returning the source word itself.
- Keep examples natural and learner-friendly.
- Meanings and notes should be Chinese.
- Do not add markdown fences.
- ${ASCII_PUNCTUATION_PROMPT_RULE}

Return valid json only:
{
  "source": "${word}",
  "words": [
    {
      "word": "enhance",
      "meaning": "提高;增强",
      "domain": "能力提升",
      "example": "This method can enhance your reading speed.",
      "note": "比 improve 更强调增强效果."
    }
  ]
}

The word "json" is intentionally included because the API JSON mode requires it.

Source word:
${word}`
				}
			]
		}));

		content = completion.choices[0]?.message?.content;
	} catch (error) {
		throw new Error(toDeepSeekErrorMessage(error));
	}

	if (!content) {
		throw new Error('DeepSeek returned an empty related-word response.');
	}

	const result = parseRelatedWordsResult(content);
	if (!result) {
		throw new Error('DeepSeek related-word response was not valid JSON in the expected shape.');
	}

	return {
		source: result.source,
		words: result.words.slice(0, 5)
	};
}

async function setDeepSeekApiKey(context: vscode.ExtensionContext) {
	const apiKey = await vscode.window.showInputBox({
		title: 'Set DeepSeek API Key',
		prompt: 'Paste your DeepSeek API key. It will be stored in VS Code SecretStorage, not in project files.',
		password: true,
		ignoreFocusOut: true,
		placeHolder: 'sk-...'
	});

	if (!apiKey?.trim()) {
		return false;
	}

	await context.secrets.store(DEEPSEEK_SECRET_KEY, apiKey.trim());
	vscode.window.showInformationMessage('DeepSeek API key saved in VS Code SecretStorage.');
	return true;
}

async function getDeepSeekApiKeyOrPrompt(context: vscode.ExtensionContext) {
	if (testDeepSeekApiKey) {
		return testDeepSeekApiKey;
	}

	const existing = await context.secrets.get(DEEPSEEK_SECRET_KEY);
	if (existing) {
		return existing;
	}

	const action = await vscode.window.showWarningMessage(
		'DeepSeek API key is not set. Save it with VS Code SecretStorage before using AI learning commands.',
		'Set API Key'
	);

	if (action !== 'Set API Key') {
		return undefined;
	}

	const saved = await setDeepSeekApiKey(context);
	return saved ? context.secrets.get(DEEPSEEK_SECRET_KEY) : undefined;
}

function getSelectedText(): SelectedText | undefined {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showWarningMessage('Open a text editor and select English or Chinese text first.');
		return undefined;
	}

	const text = editor.selections
		.map(selection => editor.document.getText(selection))
		.filter(value => value.trim().length > 0)
		.join('\n')
		.trim();

	if (!text) {
		vscode.window.showWarningMessage('Select text before running an English Learning Plugin command.');
		return undefined;
	}

	return {
		editor,
		text,
		sourceUri: editor.document.uri.toString()
	};
}

function getSelectedTextOrCurrentDocument(): SelectedText | undefined {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showWarningMessage('Open a .enlearn editor first.');
		return undefined;
	}

	const selectedText = editor.selections
		.map(selection => editor.document.getText(selection))
		.filter(value => value.trim().length > 0)
		.join('\n')
		.trim();
	const text = selectedText || editor.document.getText().trim();

	if (!text) {
		vscode.window.showWarningMessage('The current editor has no content to summarize.');
		return undefined;
	}

	return {
		editor,
		text,
		sourceUri: editor.document.uri.toString()
	};
}

function getPracticeOrGradeTarget(): PracticeOrGradeTarget | undefined {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showWarningMessage('Open a .enlearn editor first.');
		return undefined;
	}

	const documentText = editor.document.getText().trim();
	if (!documentText) {
		vscode.window.showWarningMessage('The current .enlearn file has no learning content.');
		return undefined;
	}

	const selectedText = editor.selections
		.map(selection => editor.document.getText(selection))
		.filter(value => value.trim().length > 0)
		.join('\n')
		.trim();

	return {
		editor,
		documentText,
		selectedText
	};
}

async function requestDeepSeek(apiKey: string, mode: DeepSeekRequestMode, text: string) {
	if (testDeepSeekRequester) {
		return testDeepSeekRequester(apiKey, mode, text);
	}

	const options = getDeepSeekOptions();
	const client = new OpenAI({
		apiKey,
		baseURL: options.baseUrl
	});

	let content: string | null | undefined;

	try {
		const completion = await client.chat.completions.create(withDeepSeekNonThinking({
			model: options.model,
			temperature: options.temperature,
			response_format: { type: 'json_object' },
			messages: [
				{
					role: 'system',
					content: `You are an English learning assistant for Chinese-speaking VS Code users. Respond only with valid json. Keep explanations concise and useful for language learning. ${ASCII_PUNCTUATION_PROMPT_RULE}`
				},
				{
					role: 'user',
					content: buildDeepSeekPrompt(mode, text)
				}
			]
		}));

		content = completion.choices[0]?.message?.content;
	} catch (error) {
		throw new Error(toDeepSeekErrorMessage(error));
	}

	if (!content) {
		throw new Error('DeepSeek returned an empty response.');
	}

	return {
		options,
		result: parseAiLearningResult(content, text)
	};
}

function getDeepSeekOptions(): DeepSeekOptions {
	const config = vscode.workspace.getConfiguration('englishLearning.deepseek');

	return {
		baseUrl: config.get<string>('baseUrl')?.trim() || 'https://api.deepseek.com',
		model: config.get<string>('model')?.trim() || 'deepseek-v4-flash',
		temperature: config.get<number>('temperature') ?? 0.2
	};
}

function buildDeepSeekPrompt(mode: DeepSeekRequestMode, text: string) {
	if (mode === 'contextExplain') {
		return `Explain the selected text based on its sentence context.

Return valid json only, without markdown fences. Use this JSON shape:
{
  "explanation": "一句中文 PS 解释"
}

Rules:
- 只解释 selected text 在 sentence context 里的作用。
- 说明含义、语法功能、搭配或为什么用这个形式。
- 如果是冠词 a/an/the，要解释为什么用它以及为什么不是其它冠词。
- 不要翻译整句，不要输出列表，不要输出 Markdown。
- ${ASCII_PUNCTUATION_PROMPT_RULE}
- The word "json" is intentionally included because the API JSON mode requires it.

${text}`;
	}

	if (mode === 'contextTranslate') {
		return `Translate the selected word based on its sentence context.

Return valid json only, without markdown fences. Use this JSON shape:
{
  "translation": "当前句中最合适的简短释义",
  "direction": "en-to-zh | zh-to-en | mixed"
}

Rules:
- 只翻译 selected word 在 sentence context 里的意思。
- 如果 selected word 是英文，只输出简短中文释义, 例如 "课", "课程"。
- 不要翻译整句，不要解释语法，不要输出括号、标点、列表或 Markdown。
- ${ASCII_PUNCTUATION_PROMPT_RULE}
- The word "json" is intentionally included because the API JSON mode requires it.

${text}`;
	}

	if (mode === 'practice') {
		return `Create three practice questions from the current .enlearn learning content.

Return valid json only, without markdown fences. Use this JSON shape:
{
  "questions": [
    { "type": "translate", "prompt": "需要翻译的句子或中文提示" },
    { "type": "cloze", "prompt": "I need to ____ my English reading speed." }
  ]
}

Rules:
- Return exactly 3 questions.
- Allowed type values are "translate" and "cloze" only.
- Do not include answers, hints, answer keys, explanations, or {answer|hint} cloze markers.
- Cloze questions must use blanks such as ____ instead of revealing the answer.
- Keep prompts directly related to the vocabulary, grammar, and sentences in the content.
- ${ASCII_PUNCTUATION_PROMPT_RULE}
- The word "json" is intentionally included because the API JSON mode requires it.

.enlearn content:
${text}`;
	}

	if (mode === 'gradePracticeBatch') {
		return `Grade multiple selected learner answers using the current .enlearn learning content as context.

Return valid json only, without markdown fences. Use this JSON shape:
{
  "gradings": [
    {
      "id": "item-1",
      "correct": false,
      "feedback": "一句中文反馈",
      "correction": "可选的正确答案或修改建议",
      "explanation": "如果错误, 说明为什么错"
    }
  ]
}

Rules:
- Return exactly one grading for each input item id.
- Preserve every input item id exactly.
- Use Chinese feedback.
- If the answer is correct or acceptable, set correct to true and keep feedback concise.
- If the answer is wrong or unnatural, set correct to false, provide correction and explanation.
- Do not rewrite the whole file.
- ${ASCII_PUNCTUATION_PROMPT_RULE}
- The word "json" is intentionally included because the API JSON mode requires it.

${text}`;
	}

	if (mode === 'gradePractice') {
		return `Grade the selected learner answer using the current .enlearn learning content as context.

Return valid json only, without markdown fences. Use this JSON shape:
{
  "grading": {
    "correct": false,
    "feedback": "一句中文反馈",
    "correction": "可选的正确答案或修改建议",
    "explanation": "如果错误，说明为什么错"
  }
}

Rules:
- Use Chinese feedback.
- If the answer is correct or acceptable, set correct to true and keep feedback concise.
- If the answer is wrong or unnatural, set correct to false, provide correction and explanation.
- Do not rewrite the whole file.
- ${ASCII_PUNCTUATION_PROMPT_RULE}
- The word "json" is intentionally included because the API JSON mode requires it.

${text}`;
	}

	const commonSchema = `Return valid json only, without markdown fences. Use this JSON shape:
{
  "translation": "translation text",
  "direction": "en-to-zh | zh-to-en | mixed",
  "summary": "one sentence summary",
  "explanation": "short learning explanation",
  "notes": ["learning note"],
  "grammar": ["grammar point"],
  "examples": ["example sentence"],
  "practice": ["? translate ...", "? cloze I {improve|提高} ..."],
  "vocabulary": [
    {
      "term": "word or phrase",
      "meaning": "Chinese meaning or English meaning",
      "phonetic": "/optional phonetic/",
      "example": "example sentence",
      "note": "usage note"
    }
  ]
}`;

	const task = {
		translate: 'Translate the selected text. If it is English, translate to Chinese. If it is Chinese, translate to natural English. Include short learning notes and vocabulary.',
		explain: 'Explain the selected English or Chinese-English learning text. Focus on grammar, vocabulary, collocations, and natural usage.',
		annotate: 'Create a study annotation for the selected text. Include translation, explanation, vocabulary, examples, and practice prompts.',
		enlearn: 'Create content suitable for an .enlearn study block from the selected text. Include translation, explanation, vocabulary, examples, and practice prompts.',
		summarize: 'Summarize this .enlearn learning content. Focus on core topics, key vocabulary, grammar and expressions, weak points, and concrete review suggestions.',
		contextExplain: 'Explain the selected text only by using its sentence context. Focus on the selected text role, meaning, grammar reason, and why this form is used here. Return one concise Chinese explanation suitable for inline PS annotation.',
		contextTranslate: 'Translate the selected word only by using its sentence context. Return one concise meaning for inline annotation.',
		practice: 'Create three practice questions from this .enlearn learning content.',
		gradePractice: 'Grade the selected learner answer from this .enlearn learning content.',
		gradePracticeBatch: 'Grade multiple selected learner answers from this .enlearn learning content.'
	}[mode];

	return `${task}

The word "json" is intentionally included because the API JSON mode requires it.
${ASCII_PUNCTUATION_PROMPT_RULE}

${commonSchema}

Selected text:
${text}`;
}

function parseAiLearningResult(content: string, sourceText: string): AiLearningResult {
	const object = parseJsonObject(content);
	const direction = readDirection(object.direction) ?? detectDirection(sourceText);

	return {
		translation: readString(object.translation) ?? readString(object.translatedText),
		explanation: readString(object.explanation),
		summary: readString(object.summary),
		notes: readStringArray(object.notes),
		grammar: readStringArray(object.grammar),
		examples: readStringArray(object.examples),
		practice: readStringArray(object.practice),
		vocabulary: readVocabulary(object.vocabulary),
		questions: readPracticeQuestions(object.questions),
		grading: readPracticeGrading(object.grading),
		gradings: readPracticeBatchGradings(object.gradings),
		direction
	};
}

function parseJsonObject(content: string): Record<string, unknown> {
	const trimmed = content.trim()
		.replace(/^```json\s*/i, '')
		.replace(/^```\s*/i, '')
		.replace(/\s*```$/i, '')
		.trim();

	const parsed: unknown = JSON.parse(trimmed);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('DeepSeek JSON response was not an object.');
	}

	return parsed as Record<string, unknown>;
}

function toMarkdown(mode: Exclude<LearningMode, 'annotate' | 'enlearn'>, sourceText: string, result: AiLearningResult, model: string) {
	const title = {
		translate: 'Translation',
		explain: 'Explanation',
		summarize: 'Learning Summary'
	}[mode];
	const lines = [
		`# ${title}`,
		'',
		`**Model:** ${model}`,
		`**Direction:** ${result.direction}`,
		'',
		'## Source',
		'',
		'```text',
		sourceText,
		'```'
	];

	if (result.translation) {
		lines.push('', '## Translation', '', result.translation);
	}

	if (result.summary) {
		lines.push('', '## Summary', '', result.summary);
	}

	if (result.explanation) {
		lines.push('', '## Explanation', '', result.explanation);
	}

	appendList(lines, 'Notes', result.notes);
	appendList(lines, 'Grammar', result.grammar);
	appendVocabulary(lines, result.vocabulary);
	appendList(lines, 'Examples', result.examples);
	appendList(lines, 'Practice', result.practice);

	return `${lines.join('\n')}\n`;
}

function toEnlearnBlock(sourceText: string, result: AiLearningResult, model: string) {
	const lines = [
		`# Unit: AI Learning ${formatLocalDate(new Date())}`,
		'',
		'@level auto',
		'@topic AI Generated',
		'@source deepseek',
		`@created ${formatLocalDate(new Date())}`,
		`@model ${model}`,
		`@direction ${result.direction}`,
		'',
		'## Text',
		...prefixLines(sourceText, '> '),
		'',
		'## Translation'
	];

	lines.push(...prefixLines(result.translation ?? 'TODO: add translation', '= '));

	lines.push('', '## Vocabulary');
	if (result.vocabulary.length === 0) {
		lines.push('[word] TODO');
		lines.push(': meaning TODO');
	} else {
		for (const item of result.vocabulary) {
			lines.push(`[word] ${item.term}`);
			if (item.meaning) {
				lines.push(`: meaning ${item.meaning}`);
			}
			if (item.phonetic) {
				lines.push(`: phonetic ${item.phonetic}`);
			}
			if (item.example) {
				lines.push(`: example ${item.example}`);
			}
			if (item.note) {
				lines.push(`: note ${item.note}`);
			}
			lines.push('');
		}
	}

	lines.push('## Explanation');
	const explanation = result.explanation ?? result.summary ?? result.notes.join('\n');
	lines.push(...prefixLines(explanation || 'TODO: add explanation', '! '));

	lines.push('', '## Practice');
	const practice = result.practice.length > 0 ? result.practice : ['? translate TODO', '? cloze TODO {answer|hint}'];
	for (const item of practice) {
		lines.push(item.trim().startsWith('?') ? item : `? ${item}`);
	}

	return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

function formatPracticeBlock(questions: PracticeQuestion[], date: Date) {
	const usableQuestions = questions
		.filter(question => question.prompt.trim().length > 0)
		.slice(0, 3);
	if (usableQuestions.length === 0) {
		return '';
	}

	const lines = [
		`## Practice: AI Review ${formatLocalDate(date)}`,
		''
	];
	for (const question of usableQuestions) {
		const type = question.type === 'cloze' ? 'cloze' : 'translate';
		lines.push(`? ${type} ${sanitizePracticePrompt(question.prompt)}`);
	}

	return `${lines.join('\n')}\n`;
}

function formatPracticeGrading(grading: PracticeGrading | undefined) {
	if (!grading) {
		return '';
	}

	const status = grading.correct ? '正确' : '错误';
	const parts = [`! 批改: ${status}.`];
	if (grading.feedback) {
		parts.push(grading.feedback);
	}
	if (!grading.correct && grading.correction) {
		parts.push(`建议: ${grading.correction}`);
	}
	if (!grading.correct && grading.explanation) {
		parts.push(`原因: ${grading.explanation}`);
	}

	return normalizeAsciiPunctuation(parts.join(' ').replace(/\s+/g, ' ').trim());
}

function formatUnansweredPracticeFeedback() {
	return '! 批改: 未作答. 请先填写答案.';
}

function sanitizePracticePrompt(value: string) {
	return normalizeAsciiPunctuation(value
		.replace(/^```json\s*/i, '')
		.replace(/^```\s*/i, '')
		.replace(/\s*```$/i, '')
		.replace(/^\s*\?\s*(?:translate|cloze)\b\s*/i, '')
		.replace(/\{[^{}|]+(?:\|[^{}]+)?\}/g, '____')
		.replace(/\s+/g, ' ')
		.trim());
}

async function saveLearningRecord(context: vscode.ExtensionContext, record: LearningRecord) {
	const existing = context.globalState.get<LearningRecord[]>(LEARNING_RECORDS_KEY, []);
	await context.globalState.update(LEARNING_RECORDS_KEY, [record, ...existing].slice(0, MAX_LEARNING_RECORDS));
}

async function showMarkdownDocument(content: string) {
	const document = await vscode.workspace.openTextDocument({
		content,
		language: 'markdown'
	});

	await vscode.window.showTextDocument(document, {
		preview: true,
		viewColumn: vscode.ViewColumn.Beside
	});
}

async function showEnlearnDocument(content: string) {
	const document = await vscode.workspace.openTextDocument({
		content,
		language: 'enlearn'
	});

	await vscode.window.showTextDocument(document, {
		preview: false,
		viewColumn: vscode.ViewColumn.Beside
	});
}

function appendList(lines: string[], title: string, items: string[]) {
	if (items.length === 0) {
		return;
	}

	lines.push('', `## ${title}`, '');
	for (const item of items) {
		lines.push(`- ${item}`);
	}
}

function appendVocabulary(lines: string[], vocabulary: VocabularyItem[]) {
	if (vocabulary.length === 0) {
		return;
	}

	lines.push('', '## Vocabulary', '');
	for (const item of vocabulary) {
		const details = [item.meaning, item.phonetic, item.note].filter(Boolean).join(' | ');
		lines.push(`- **${item.term}**${details ? `: ${details}` : ''}`);
		if (item.example) {
			lines.push(`  Example: ${item.example}`);
		}
	}
}

function prefixLines(text: string, prefix: string) {
	return text.split(/\r?\n/).map(line => `${prefix}${line}`);
}

function readString(value: unknown) {
	return typeof value === 'string' && value.trim().length > 0 ? normalizeAsciiPunctuation(value.trim()) : undefined;
}

function readStringArray(value: unknown) {
	if (Array.isArray(value)) {
		return value
			.map(item => typeof item === 'string' ? normalizeAsciiPunctuation(item.trim()) : normalizeAsciiPunctuation(JSON.stringify(item)))
			.filter(item => item.length > 0);
	}

	const text = readString(value);
	return text ? [text] : [];
}

function readVocabulary(value: unknown): VocabularyItem[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.flatMap(item => {
		if (typeof item === 'string') {
			return [{ term: item }];
		}

		if (!item || typeof item !== 'object' || Array.isArray(item)) {
			return [];
		}

		const object = item as Record<string, unknown>;
		const term = readString(object.term) ?? readString(object.word) ?? readString(object.phrase);
		if (!term) {
			return [];
		}

		return [{
			term,
			meaning: readString(object.meaning),
			phonetic: readString(object.phonetic),
			example: readString(object.example),
			note: readString(object.note)
		}];
	});
}

function readPracticeQuestions(value: unknown): PracticeQuestion[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.flatMap(item => {
		if (!item || typeof item !== 'object' || Array.isArray(item)) {
			return [];
		}

		const object = item as Record<string, unknown>;
		const prompt = readString(object.prompt) ?? readString(object.question);
		if (!prompt) {
			return [];
		}

		return [{
			type: readPracticeQuestionType(object.type),
			prompt
		}];
	});
}

function readPracticeQuestionType(value: unknown): PracticeQuestionType {
	return value === 'cloze' ? 'cloze' : 'translate';
}

function readPracticeGrading(value: unknown): PracticeGrading | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}

	const object = value as Record<string, unknown>;
	const correct = readBoolean(object.correct);
	if (correct === undefined) {
		return undefined;
	}

	return {
		correct,
		feedback: readString(object.feedback),
		correction: readString(object.correction),
		explanation: readString(object.explanation)
	};
}

function readPracticeBatchGradings(value: unknown): PracticeBatchGrading[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.flatMap(item => {
		if (!item || typeof item !== 'object' || Array.isArray(item)) {
			return [];
		}

		const object = item as Record<string, unknown>;
		const id = readString(object.id);
		const correct = readBoolean(object.correct);
		if (!id || correct === undefined) {
			return [];
		}

		return [{
			id,
			correct,
			feedback: readString(object.feedback),
			correction: readString(object.correction),
			explanation: readString(object.explanation)
		}];
	});
}

function readBoolean(value: unknown) {
	return typeof value === 'boolean' ? value : undefined;
}

function readDirection(value: unknown): LearningDirection | undefined {
	if (value === 'en-to-zh' || value === 'zh-to-en' || value === 'mixed') {
		return value;
	}

	return undefined;
}

function detectDirection(text: string): LearningDirection {
	const hasCjk = /[\u3400-\u9fff]/u.test(text);
	const hasLatin = /[A-Za-z]/u.test(text);

	if (hasCjk && hasLatin) {
		return 'mixed';
	}

	return hasCjk ? 'zh-to-en' : 'en-to-zh';
}

function getProgressTitle(mode: LearningMode) {
	return {
		translate: 'English Learning Plugin: translating selection',
		explain: 'English Learning Plugin: explaining selection',
		annotate: 'English Learning Plugin: creating study annotation',
		enlearn: 'English Learning Plugin: generating .enlearn block',
		summarize: 'English Learning Plugin: summarizing learning content'
	}[mode];
}

function toDeepSeekErrorMessage(error: unknown) {
	const status = readStatusCode(error);
	const bodyMessage = readErrorMessage(error);

	if (status === 401) {
		return 'DeepSeek rejected the API key (401). Run "English Learning Plugin: Set DeepSeek API Key" and save a valid key.';
	}

	if (status === 402) {
		return 'DeepSeek account balance is insufficient (402). Check billing before retrying.';
	}

	if (status === 429) {
		return 'DeepSeek rate limit was reached (429). Wait and retry later.';
	}

	if (status === 500) {
		return 'DeepSeek returned an internal server error (500). Retry later.';
	}

	if (status === 503) {
		return 'DeepSeek service is busy or unavailable (503). Retry later.';
	}

	if (status) {
		return `DeepSeek request failed with HTTP ${status}${bodyMessage ? `: ${bodyMessage}` : '.'}`;
	}

	return bodyMessage ? `DeepSeek request failed: ${bodyMessage}` : 'DeepSeek request failed.';
}

function readStatusCode(error: unknown) {
	if (!error || typeof error !== 'object') {
		return undefined;
	}

	const value = (error as { status?: unknown; statusCode?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
	return typeof value === 'number' ? value : undefined;
}

function readErrorMessage(error: unknown) {
	if (error instanceof Error && error.message) {
		return error.message;
	}

	if (!error || typeof error !== 'object') {
		return undefined;
	}

	const value = (error as { message?: unknown }).message;
	return typeof value === 'string' ? value : undefined;
}

function handleCommandError(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
	vscode.window.showErrorMessage(message);
}

function createRecordId() {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatLocalDate(date: Date) {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

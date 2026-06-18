import OpenAI from 'openai';
import * as vscode from 'vscode';
import {
	EnlearnValidationIssue,
	findEnglishWords,
	parseAiValidationIssues,
	validateEnlearnFormatText
} from './enlearnValidation';
import {
	EnlearnPredictionResult,
	buildPredictionContext,
	parsePredictionResult,
	shouldTriggerPrediction
} from './enlearnPrediction';

const DEEPSEEK_SECRET_KEY = 'englishLearning.deepseek.apiKey';
const LEARNING_RECORDS_KEY = 'englishLearning.records';
const MAX_LEARNING_RECORDS = 200;
const ENLEARN_LANGUAGE_ID = 'enlearn';

type LearningMode = 'translate' | 'explain' | 'annotate' | 'enlearn' | 'summarize';
type LearningDirection = 'en-to-zh' | 'zh-to-en' | 'mixed';

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

interface AiLearningResult {
	translation?: string;
	explanation?: string;
	summary?: string;
	notes: string[];
	grammar: string[];
	examples: string[];
	practice: string[];
	vocabulary: VocabularyItem[];
	direction: LearningDirection;
}

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

let outputChannel: vscode.OutputChannel;
let enlearnDiagnosticCollection: vscode.DiagnosticCollection;
let englishWordDecorationType: vscode.TextEditorDecorationType | undefined;
let missingValidationApiKeyNoticeShown = false;
const validationTimers = new Map<string, ReturnType<typeof setTimeout>>();
let latestPrediction: PredictionCacheEntry | undefined;
const predictionCache = new Map<string, PredictionCacheEntry>();

export function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel('English Learning Plugin');
	enlearnDiagnosticCollection = vscode.languages.createDiagnosticCollection('english-learning-plugin');
	context.subscriptions.push(outputChannel);
	context.subscriptions.push(enlearnDiagnosticCollection);

	context.subscriptions.push(
		vscode.commands.registerCommand('englishLearning.translateSelection', () => runLearningCommand(context, 'translate')),
		vscode.commands.registerCommand('englishLearning.explainSelection', () => runLearningCommand(context, 'explain')),
		vscode.commands.registerCommand('englishLearning.annotateSelection', () => runLearningCommand(context, 'annotate')),
		vscode.commands.registerCommand('englishLearning.insertEnlearnBlock', () => insertEnlearnBlock(context)),
		vscode.commands.registerCommand('englishLearning.summarizeLearningContent', () => summarizeLearningContent(context)),
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
			scheduleEnlearnValidation(context, event.document);
		}),
		vscode.workspace.onDidSaveTextDocument(document => {
			if (isEnlearnDocument(document)) {
				void validateEnlearnDocument(context, document, true);
			}
		}),
		vscode.workspace.onDidOpenTextDocument(document => {
			if (isEnlearnDocument(document)) {
				void validateEnlearnDocument(context, document, true);
			}
		}),
		vscode.workspace.onDidCloseTextDocument(document => {
			const timer = validationTimers.get(document.uri.toString());
			if (timer) {
				clearTimeout(timer);
			}
			validationTimers.delete(document.uri.toString());
			enlearnDiagnosticCollection.delete(document.uri);
		}),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('englishLearning.highlight.englishWords')) {
				refreshEnglishWordDecoration();
				updateAllVisibleEnglishWordHighlights();
			}

			if (event.affectsConfiguration('englishLearning.validation')) {
				for (const document of vscode.workspace.textDocuments) {
					if (isEnlearnDocument(document)) {
						void validateEnlearnDocument(context, document, true);
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
				predictionCache.clear();
				latestPrediction = undefined;
			}
		}
	);

	refreshEnglishWordDecoration();
	updateAllVisibleEnglishWordHighlights();
	for (const document of vscode.workspace.textDocuments) {
		if (isEnlearnDocument(document)) {
			void validateEnlearnDocument(context, document, true);
		}
	}
}

export function deactivate() {}

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

	const completion = await client.chat.completions.create({
		model: options.model,
		temperature: 0.4,
		response_format: { type: 'json_object' },
		messages: [
			{
				role: 'system',
				content: 'You predict concise natural English continuations for Chinese-speaking learners. Respond only with valid json.'
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
	});

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

function refreshEnglishWordDecoration() {
	englishWordDecorationType?.dispose();

	const config = vscode.workspace.getConfiguration('englishLearning.highlight.englishWords');
	const color = config.get<string>('color')?.trim() || '#2F80ED';
	englishWordDecorationType = vscode.window.createTextEditorDecorationType({
		color,
		fontWeight: '600'
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
	if (!editor || !englishWordDecorationType) {
		return;
	}

	const enabled = vscode.workspace.getConfiguration('englishLearning.highlight.englishWords').get<boolean>('enabled', true);
	if (!enabled || !isEnlearnDocument(editor.document)) {
		editor.setDecorations(englishWordDecorationType, []);
		return;
	}

	const ranges = findEnglishWords(editor.document.getText()).map(match => new vscode.Range(
		match.line,
		match.startCharacter,
		match.line,
		match.endCharacter
	));
	editor.setDecorations(englishWordDecorationType, ranges);
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

	if (includeAi && vscode.workspace.getConfiguration('englishLearning.validation.ai').get<boolean>('enabled', true)) {
		const apiKey = await context.secrets.get(DEEPSEEK_SECRET_KEY);
		if (!apiKey) {
			void showMissingValidationApiKeyNotice();
		} else {
			try {
				issues.push(...await requestDeepSeekValidationIssues(apiKey, text));
			} catch (error) {
				outputChannel.appendLine(`[${new Date().toISOString()}] AI validation failed: ${readErrorMessage(error) ?? String(error)}`);
			}
		}
	}

	if (document.version !== version) {
		return;
	}

	enlearnDiagnosticCollection.set(document.uri, toDiagnostics(document, issues));
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

async function requestDeepSeekValidationIssues(apiKey: string, text: string): Promise<EnlearnValidationIssue[]> {
	if (!/[A-Za-z]/.test(text)) {
		return [];
	}

	const options = getDeepSeekOptions();
	const client = new OpenAI({
		apiKey,
		baseURL: options.baseUrl
	});

	const completion = await client.chat.completions.create({
		model: options.model,
		temperature: 0,
		response_format: { type: 'json_object' },
		messages: [
			{
				role: 'system',
				content: 'You are an English spelling, grammar, and usage checker for .enlearn study notes. Respond only with valid json.'
			},
			{
				role: 'user',
				content: `Check this .enlearn document for English spelling errors, grammar errors, wrong word usage, and unnatural expressions.

Ignore .enlearn syntax markers such as #, ##, @key, >, =, [word], :, !, ?, {answer|hint}, and // comments. Report only real English learning issues.

Return valid json only. Use this JSON shape:
{
  "issues": [
    {
      "text": "wrong text",
      "kind": "spelling | grammar | usage",
      "message": "语法错误：explain the issue in Chinese",
      "suggestion": "correct text",
      "severity": "error | warning"
    }
  ]
}

The word "json" is intentionally included because the API JSON mode requires it.

Document:
${text}`
			}
		]
	});

	const content = completion.choices[0]?.message?.content;
	return content ? parseAiValidationIssues(content) : [];
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
	const message = issue.message.startsWith(label) ? issue.message : `${label}：${issue.message}`;
	return issue.suggestion ? `${message}\n建议：${issue.suggestion}` : message;
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
			const response = await requestDeepSeek(apiKey, mode, selected.text);
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

async function requestDeepSeek(apiKey: string, mode: LearningMode, text: string) {
	const options = getDeepSeekOptions();
	const client = new OpenAI({
		apiKey,
		baseURL: options.baseUrl
	});

	let content: string | null | undefined;

	try {
		const completion = await client.chat.completions.create({
			model: options.model,
			temperature: options.temperature,
			response_format: { type: 'json_object' },
			messages: [
				{
					role: 'system',
					content: 'You are an English learning assistant for Chinese-speaking VS Code users. Respond only with valid json. Keep explanations concise and useful for language learning.'
				},
				{
					role: 'user',
					content: buildDeepSeekPrompt(mode, text)
				}
			]
		});

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

function buildDeepSeekPrompt(mode: LearningMode, text: string) {
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
		summarize: 'Summarize this .enlearn learning content. Focus on core topics, key vocabulary, grammar and expressions, weak points, and concrete review suggestions.'
	}[mode];

	return `${task}

The word "json" is intentionally included because the API JSON mode requires it.

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
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown) {
	if (Array.isArray(value)) {
		return value
			.map(item => typeof item === 'string' ? item.trim() : JSON.stringify(item))
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

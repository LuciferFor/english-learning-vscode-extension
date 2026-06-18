import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	extractCheckableEnglishSegments,
	findEnglishWords,
	hashText,
	parseAiValidationIssues,
	validateEnlearnFormatText
} from '../enlearnValidation';
import {
	buildPredictionContext,
	parsePredictionResult,
	shouldTriggerPrediction
} from '../enlearnPrediction';
import {
	formatRelatedWordBlock,
	getEnglishWordAt,
	normalizeRelatedWordInput,
	parseRelatedWordsResult
} from '../relatedWords';
import { ENGLISH_LEARNING_ACTIONS } from '../sidebarActions';
import {
	DEFAULT_TTS_SETTINGS,
	buildPowerShellMediaPlayerScript,
	normalizeTtsText,
	toTtsValidationMessage,
	validateTtsText
} from '../tts';

suite('English Learning Plugin extension', () => {
	test('registers .enlearn language', async () => {
		const languages = await vscode.languages.getLanguages();
		assert.ok(languages.includes('enlearn'));
	});

	test('contributes English Learning Plugin commands', async () => {
		const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'english-learning-plugin');
		assert.ok(extension);
		await extension.activate();

		const commands = await vscode.commands.getCommands(true);

		assert.ok(commands.includes('englishLearning.translateSelection'));
		assert.ok(commands.includes('englishLearning.explainSelection'));
		assert.ok(commands.includes('englishLearning.annotateSelection'));
		assert.ok(commands.includes('englishLearning.insertEnlearnBlock'));
		assert.ok(commands.includes('englishLearning.summarizeLearningContent'));
		assert.ok(commands.includes('englishLearning.generateRelatedWords'));
		assert.ok(commands.includes('englishLearning.insertRelatedWord'));
		assert.ok(commands.includes('englishLearning.playSelectionAudio'));
		assert.ok(commands.includes('englishLearning.setApiKey'));
	});

	test('contributes only .enlearn scoped default keybindings', () => {
		const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'english-learning-plugin');
		assert.ok(extension);

		const keybindings = extension.packageJSON.contributes.keybindings as Array<{
			command: string;
			key: string;
			when: string;
		}>;

		assert.strictEqual(keybindings.length, 6);
		assert.deepStrictEqual(keybindings.map(item => [item.key, item.command]), [
			['ctrl+alt+q', 'englishLearning.explainSelection'],
			['ctrl+alt+w', 'englishLearning.translateSelection'],
			['ctrl+alt+e', 'englishLearning.summarizeLearningContent'],
			['ctrl+alt+a', 'englishLearning.insertEnlearnBlock'],
			['ctrl+alt+s', 'englishLearning.generateRelatedWords'],
			['ctrl+alt+d', 'englishLearning.playSelectionAudio']
		]);

		for (const keybinding of keybindings) {
			assert.ok(keybinding.when.includes('editorLangId == enlearn'));
		}
	});

	test('contributes sidebar view and related words menu command', () => {
		const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'english-learning-plugin');
		assert.ok(extension);

		const contributes = extension.packageJSON.contributes;
		assert.ok(contributes.viewsContainers.activitybar.some((item: { id: string }) => item.id === 'englishLearning'));
		assert.ok(contributes.views.englishLearning.some((item: { id: string }) => item.id === 'englishLearning.actionsView'));
		assert.ok(contributes.menus['view/title'].some((item: { command: string }) => item.command === 'englishLearning.generateRelatedWords'));
		assert.ok(contributes.menus['view/title'].some((item: { command: string }) => item.command === 'englishLearning.playSelectionAudio'));
		assert.ok(contributes.menus['editor/context'].some((item: { command: string }) => item.command === 'englishLearning.generateRelatedWords'));
		assert.ok(contributes.menus['editor/context'].some((item: { command: string }) => item.command === 'englishLearning.playSelectionAudio'));
	});

	test('sidebar actions show shortcuts in labels', () => {
		assert.deepStrictEqual(ENGLISH_LEARNING_ACTIONS.map(action => action.shortcut), [
			'Ctrl+Alt+Q',
			'Ctrl+Alt+W',
			'Ctrl+Alt+E',
			'Ctrl+Alt+A',
			'Ctrl+Alt+S',
			'Ctrl+Alt+D'
		]);

		for (const action of ENGLISH_LEARNING_ACTIONS) {
			assert.ok(action.label.includes(action.shortcut));
		}
	});

	test('contributes validation and highlighting settings', () => {
		const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'english-learning-plugin');
		assert.ok(extension);

		const properties = extension.packageJSON.contributes.configuration.properties as Record<string, unknown>;

		assert.ok(properties['englishLearning.validation.enabled']);
		assert.ok(properties['englishLearning.validation.ai.enabled']);
		assert.ok(properties['englishLearning.validation.debounceMs']);
		assert.ok(properties['englishLearning.highlight.englishWords.enabled']);
		assert.ok(properties['englishLearning.highlight.englishWords.color']);
		assert.ok(properties['englishLearning.prediction.enabled']);
		assert.ok(properties['englishLearning.prediction.showTranslationHover']);
		assert.ok(properties['englishLearning.prediction.maxContextChars']);
		assert.ok(properties['englishLearning.prediction.debounceMs']);
		assert.ok(properties['englishLearning.tts.voice']);
		assert.ok(properties['englishLearning.tts.lang']);
		assert.ok(properties['englishLearning.tts.rate']);
		assert.ok(properties['englishLearning.tts.pitch']);
		assert.ok(properties['englishLearning.tts.volume']);
		assert.ok(properties['englishLearning.tts.timeoutMs']);
		assert.ok(properties['englishLearning.tts.maxTextLength']);
		assert.strictEqual((properties['englishLearning.tts.voice'] as { default: string }).default, DEFAULT_TTS_SETTINGS.voice);
		assert.strictEqual((properties['englishLearning.tts.lang'] as { default: string }).default, DEFAULT_TTS_SETTINGS.lang);
	});

	test('matches English words, contractions, and hyphenated words', () => {
		const words = findEnglishWords("English words don't miss reading-speed.").map(match => match.text);

		assert.deepStrictEqual(words, ['English', 'words', "don't", 'miss', 'reading-speed']);
	});

	test('validates local .enlearn format issues', () => {
		const issues = validateEnlearnFormatText([
			'@ bad',
			'[word]',
			': typo value',
			'? cloze I need {improve} this'
		].join('\n'));

		assert.ok(issues.some(issue => issue.message.includes('元数据')));
		assert.ok(issues.some(issue => issue.message.includes('[word]')));
		assert.ok(issues.some(issue => issue.message.includes('未知词条字段')));
		assert.ok(issues.some(issue => issue.message.includes('cloze')));
	});

	test('extracts changed English segments for incremental AI validation', () => {
		const segments = extractCheckableEnglishSegments([
			'= English in translation line is ignored',
			'@topic English metadata is ignored',
			'[word] improve',
			'// English comment is ignored',
			'# Unit English title is ignored',
			'> He go school.',
			'! This phrase sounds natural.',
			': example I want to improve my speaking.',
			'? cloze I {go|去} home.'
		].join('\n'));

		assert.deepStrictEqual(segments.map(segment => segment.text), [
			'He go school.',
			'This phrase sounds natural.',
			'I want to improve my speaking.',
			'I {go|去} home.'
		]);
		assert.strictEqual(hashText('same'), hashText('same'));
		assert.notStrictEqual(hashText('same'), hashText('different'));
	});

	test('parses AI validation issues', () => {
		const issues = parseAiValidationIssues(JSON.stringify({
			issues: [
				{
					segmentId: 'line-1-abc',
					text: 'He go',
					kind: 'grammar',
					message: '语法错误：主谓不一致。',
					suggestion: 'He goes',
					severity: 'error'
				}
			]
		}));

		assert.strictEqual(issues.length, 1);
		assert.strictEqual(issues[0].kind, 'grammar');
		assert.strictEqual(issues[0].text, 'He go');
		assert.strictEqual(issues[0].segmentId, 'line-1-abc');
		assert.strictEqual(issues[0].suggestion, 'He goes');
	});

	test('parses and formats related words', () => {
		const result = parseRelatedWordsResult(JSON.stringify({
			source: 'improve',
			words: [
				{ word: 'enhance', meaning: '提高；增强', domain: '能力提升', example: 'This method can enhance your reading speed.' },
				{ word: 'refine', meaning: '改进；完善' },
				{ word: 'strengthen', meaning: '加强' },
				{ word: 'upgrade', meaning: '升级' },
				{ word: 'develop', meaning: '发展' },
				{ word: 'boost', meaning: '提升' }
			]
		}));

		assert.ok(result);
		assert.strictEqual(result.source, 'improve');
		assert.strictEqual(result.words.length, 5);
		assert.strictEqual(getEnglishWordAt("I don't like reading-speed.", 4), "don't");
		assert.strictEqual(normalizeRelatedWordInput(' improve this'), 'improve');
		assert.ok(formatRelatedWordBlock(result.words[0]).includes(': note 相关领域：能力提升'));
	});

	test('normalizes and validates TTS text', () => {
		assert.strictEqual(normalizeTtsText(['  Hello  ', '', ' world.\n']), 'Hello world.');
		assert.strictEqual(validateTtsText('', 10), 'empty');
		assert.strictEqual(validateTtsText('abcdefghijk', 10), 'tooLong');
		assert.strictEqual(validateTtsText('你好', 10), 'noEnglish');
		assert.strictEqual(validateTtsText('Hello', 10), undefined);
		assert.ok(toTtsValidationMessage('tooLong', 10).includes('10'));
	});

	test('builds PowerShell MediaPlayer script safely', () => {
		const script = buildPowerShellMediaPlayerScript("C:\\tmp\\learner's.mp3");

		assert.ok(script.includes('System.Windows.Media.MediaPlayer'));
		assert.ok(script.includes("'C:\\tmp\\learner''s.mp3'"));
		assert.ok(script.includes('Resolve-Path -LiteralPath'));
		assert.ok(script.includes('$player.Play()'));
	});

	test('parses prediction result with English completion and Chinese translation', () => {
		const prediction = parsePredictionResult(JSON.stringify({
			completion: 'and practice speaking every day.',
			translation: '并且每天练习口语。'
		}));

		assert.ok(prediction);
		assert.strictEqual(prediction.completion, 'and practice speaking every day.');
		assert.strictEqual(prediction.translation, '并且每天练习口语。');
	});

	test('rejects unsafe prediction completions', () => {
		assert.strictEqual(parsePredictionResult(JSON.stringify({
			completion: '然后每天练习。',
			translation: '然后每天练习。'
		})), undefined);
	});

	test('detects valid and blocked prediction trigger lines', () => {
		assert.strictEqual(shouldTriggerPrediction('> I want to improve'), true);
		assert.strictEqual(shouldTriggerPrediction('! This phrase means'), true);
		assert.strictEqual(shouldTriggerPrediction(': example I want to improve'), true);
		assert.strictEqual(shouldTriggerPrediction('? cloze I need to'), true);
		assert.strictEqual(shouldTriggerPrediction('= 我想提高英语'), false);
		assert.strictEqual(shouldTriggerPrediction('@topic English'), false);
		assert.strictEqual(shouldTriggerPrediction('[word] improve'), false);
		assert.strictEqual(shouldTriggerPrediction('// English comment'), false);
	});

	test('truncates prediction context to max characters', () => {
		const context = buildPredictionContext('abc\ndef\nghi', { line: 2, character: 2 }, 5);

		assert.strictEqual(context.length, 5);
		assert.strictEqual(context, 'ef\ngh');
	});
});

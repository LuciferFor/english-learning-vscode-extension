import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	findEnglishWords,
	parseAiValidationIssues,
	validateEnlearnFormatText
} from '../enlearnValidation';
import {
	buildPredictionContext,
	parsePredictionResult,
	shouldTriggerPrediction
} from '../enlearnPrediction';

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

		assert.strictEqual(keybindings.length, 4);
		assert.deepStrictEqual(keybindings.map(item => [item.key, item.command]), [
			['ctrl+alt+q', 'englishLearning.explainSelection'],
			['ctrl+alt+w', 'englishLearning.translateSelection'],
			['ctrl+alt+e', 'englishLearning.summarizeLearningContent'],
			['ctrl+alt+a', 'englishLearning.insertEnlearnBlock']
		]);

		for (const keybinding of keybindings) {
			assert.ok(keybinding.when.includes('editorLangId == enlearn'));
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

	test('parses AI validation issues', () => {
		const issues = parseAiValidationIssues(JSON.stringify({
			issues: [
				{
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
		assert.strictEqual(issues[0].suggestion, 'He goes');
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

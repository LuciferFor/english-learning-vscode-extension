export interface EnglishLearningAction {
	id: string;
	label: string;
	command: string;
	shortcut: string;
	requiresSelection: boolean;
}

export const ENGLISH_LEARNING_ACTIONS: EnglishLearningAction[] = [
	{
		id: 'explainSelection',
		label: 'Explain Selection (Ctrl+Alt+Q)',
		command: 'englishLearning.explainSelection',
		shortcut: 'Ctrl+Alt+Q',
		requiresSelection: true
	},
	{
		id: 'translateSelection',
		label: 'Translate Selection (Ctrl+Alt+W)',
		command: 'englishLearning.translateSelection',
		shortcut: 'Ctrl+Alt+W',
		requiresSelection: true
	},
	{
		id: 'summarizeLearningContent',
		label: 'Summarize Content (Ctrl+Alt+E)',
		command: 'englishLearning.summarizeLearningContent',
		shortcut: 'Ctrl+Alt+E',
		requiresSelection: false
	},
	{
		id: 'insertEnlearnBlock',
		label: 'Insert .enlearn Block (Ctrl+Alt+A)',
		command: 'englishLearning.insertEnlearnBlock',
		shortcut: 'Ctrl+Alt+A',
		requiresSelection: true
	},
	{
		id: 'generateRelatedWords',
		label: 'Generate Related Words (Ctrl+Alt+S)',
		command: 'englishLearning.generateRelatedWords',
		shortcut: 'Ctrl+Alt+S',
		requiresSelection: false
	},
	{
		id: 'playSelectionAudio',
		label: 'Play Pronunciation (Ctrl+Alt+D)',
		command: 'englishLearning.playSelectionAudio',
		shortcut: 'Ctrl+Alt+D',
		requiresSelection: true
	}
];

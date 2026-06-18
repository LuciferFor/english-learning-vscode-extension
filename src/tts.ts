export interface TtsSettings {
	voice: string;
	lang: string;
	rate: string;
	pitch: string;
	volume: string;
	timeoutMs: number;
	maxTextLength: number;
}

export type TtsValidationError = 'empty' | 'tooLong' | 'noEnglish';

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
	voice: 'en-GB-SoniaNeural',
	lang: 'en-GB',
	rate: '+0%',
	pitch: '+0Hz',
	volume: '+0%',
	timeoutMs: 10000,
	maxTextLength: 500
};

export function normalizeTtsText(values: string[]) {
	return values
		.map(value => value.trim())
		.filter(value => value.length > 0)
		.join(' ')
		.replace(/\s+/g, ' ')
		.trim();
}

export function validateTtsText(text: string, maxTextLength: number): TtsValidationError | undefined {
	if (text.length === 0) {
		return 'empty';
	}

	if (text.length > maxTextLength) {
		return 'tooLong';
	}

	if (!/[A-Za-z]/.test(text)) {
		return 'noEnglish';
	}

	return undefined;
}

export function toTtsValidationMessage(error: TtsValidationError, maxTextLength: number) {
	return {
		empty: 'Select an English word or sentence before playing pronunciation.',
		tooLong: `Selected text is too long for pronunciation playback. Keep it within ${maxTextLength} characters.`,
		noEnglish: 'Selected text does not contain English letters.'
	}[error];
}

export function buildPowerShellMediaPlayerScript(audioPath: string) {
	const escapedAudioPath = toPowerShellSingleQuotedString(audioPath);

	return [
		"$ErrorActionPreference = 'Stop'",
		'Add-Type -AssemblyName PresentationCore',
		`$audioPath = ${escapedAudioPath}`,
		'$audioUri = [Uri]::new((Resolve-Path -LiteralPath $audioPath).ProviderPath)',
		`$player = New-Object System.Windows.Media.MediaPlayer`,
		'$player.Open($audioUri)',
		'$player.Play()',
		'while (-not $player.NaturalDuration.HasTimeSpan) { Start-Sleep -Milliseconds 50 }',
		'Start-Sleep -Milliseconds ([Math]::Ceiling($player.NaturalDuration.TimeSpan.TotalMilliseconds) + 100)',
		'$player.Stop()',
		'$player.Close()'
	].join('; ');
}

function toPowerShellSingleQuotedString(value: string) {
	return `'${value.replace(/'/g, "''")}'`;
}

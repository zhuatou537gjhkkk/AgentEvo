import { useEffect, useState } from 'react';
import { useChatStore } from '../../store/chatStore';
import { SectionHeading } from './SettingsWorkspace';

export default function AppearanceVoicePanel() {
    const isVoiceEnabled = useChatStore((state) => state.isVoiceEnabled);
    const toggleVoice = useChatStore((state) => state.toggleVoice);
    const voiceRate = useChatStore((state) => state.voiceRate);
    const setVoiceRate = useChatStore((state) => state.setVoiceRate);
    const voiceVolume = useChatStore((state) => state.voiceVolume);
    const setVoiceVolume = useChatStore((state) => state.setVoiceVolume);
    const voiceName = useChatStore((state) => state.voiceName);
    const setVoiceName = useChatStore((state) => state.setVoiceName);
    const themeMode = useChatStore((state) => state.themeMode);
    const setThemeMode = useChatStore((state) => state.setThemeMode);
    const [voices, setVoices] = useState([]);
    const speechSupported = typeof window !== 'undefined' && Boolean(window.speechSynthesis);

    useEffect(() => {
        if (!speechSupported) return undefined;
        const updateVoices = () => setVoices(window.speechSynthesis.getVoices() || []);
        updateVoices();
        window.speechSynthesis.addEventListener('voiceschanged', updateVoices);
        return () => window.speechSynthesis.removeEventListener('voiceschanged', updateVoices);
    }, [speechSupported]);

    return (
        <section>
            <SectionHeading title="外观与语音" scope="当前浏览器" description="主题和语音偏好只保存在当前浏览器，不影响其他会话或设备。" />
            <div className="grid gap-3 md:grid-cols-2">
                <label className="surface-card p-4">
                    <span className="text-sm font-semibold text-[var(--text-main)]">主题模式</span>
                    <select value={themeMode} onChange={(event) => setThemeMode(event.target.value)} className="ui-select mt-3 w-full px-2 py-2 text-sm">
                        <option value="system">跟随系统</option>
                        <option value="light">浅色</option>
                        <option value="dark">深色</option>
                    </select>
                </label>
                <label className="surface-card flex items-center justify-between gap-3 p-4">
                    <span className="text-sm font-semibold text-[var(--text-main)]">自动语音播报</span>
                    <input type="checkbox" checked={isVoiceEnabled} onChange={toggleVoice} disabled={!speechSupported} className="h-4 w-4" />
                </label>
                <label className="surface-card p-4">
                    <div className="flex justify-between text-sm"><span className="font-semibold text-[var(--text-main)]">语速</span><span className="text-[var(--brand-start)]">{Number(voiceRate).toFixed(1)}</span></div>
                    <input type="range" min="0.5" max="2" step="0.1" value={voiceRate} onChange={(event) => setVoiceRate(Number(event.target.value))} className="mt-3 w-full accent-[var(--brand-start)]" />
                </label>
                <label className="surface-card p-4">
                    <div className="flex justify-between text-sm"><span className="font-semibold text-[var(--text-main)]">音量</span><span className="text-[var(--brand-start)]">{Math.round(Number(voiceVolume) * 100)}%</span></div>
                    <input type="range" min="0" max="1" step="0.1" value={voiceVolume} onChange={(event) => setVoiceVolume(Number(event.target.value))} className="mt-3 w-full accent-[var(--brand-start)]" />
                </label>
                <label className="surface-card p-4 md:col-span-2">
                    <span className="text-sm font-semibold text-[var(--text-main)]">音色</span>
                    <select value={voiceName} onChange={(event) => setVoiceName(event.target.value)} disabled={!speechSupported} className="ui-select mt-3 w-full px-2 py-2 text-sm">
                        <option value="">系统默认（自动优先中文）</option>
                        {voices.map((voice) => <option key={`${voice.name}-${voice.lang}`} value={voice.name}>{voice.name} ({voice.lang || 'unknown'})</option>)}
                    </select>
                    {!speechSupported && <p className="mt-2 text-xs text-[var(--text-muted)]">当前浏览器不支持语音合成，已保留其他偏好设置。</p>}
                </label>
            </div>
        </section>
    );
}

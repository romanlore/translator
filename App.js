import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import * as Speech from 'expo-speech';
import * as Clipboard from 'expo-clipboard';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { transcribeAndTranslateAudio, translateText } from './src/services/gemini';

const STORAGE_KEYS = {
  API_KEY: '@ru_hi_gemini_api_key',
  MODEL: '@ru_hi_gemini_model',
  AUTO_SPEAK: '@ru_hi_auto_speak',
  TRANSLIT: '@ru_hi_translit',
};

const MODELS = [
  { id: 'gemini-3.8-flash', label: 'gemini-3.8-flash (рекомендуемая)' },
  { id: 'gemini-3.5-flash-lite', label: 'gemini-3.5-flash-lite (быстрая)' },
  { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash' },
];

function TranslatorScreen() {
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('gemini-3.8-flash');
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [showTranslit, setShowTranslit] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [messages, setMessages] = useState([]);
  const [activeDir, setActiveDir] = useState(null); // 'ru-hi' | 'hi-ru' | null
  const [manualDir, setManualDir] = useState('ru-hi');
  const [manualText, setManualText] = useState('');
  const [busy, setBusy] = useState(false);

  const listRef = useRef(null);
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(audioRecorder);

  useEffect(() => {
    (async () => {
      try {
        const [savedKey, savedModel, savedSpeak, savedTranslit] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEYS.API_KEY),
          AsyncStorage.getItem(STORAGE_KEYS.MODEL),
          AsyncStorage.getItem(STORAGE_KEYS.AUTO_SPEAK),
          AsyncStorage.getItem(STORAGE_KEYS.TRANSLIT),
        ]);
        if (savedKey) setApiKey(savedKey);
        else setSettingsOpen(true);
        if (savedModel) setModel(savedModel);
        if (savedSpeak !== null) setAutoSpeak(savedSpeak === 'true');
        if (savedTranslit !== null) setShowTranslit(savedTranslit === 'true');
      } catch {
        setSettingsOpen(true);
      }

      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Доступ к микрофону', 'Разрешите доступ к микрофону в настройках телефона.');
      }
      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: true,
      });
    })();
  }, []);

  const saveSettings = async () => {
    const cleanKey = apiKey.trim();
    setApiKey(cleanKey);
    await Promise.all([
      AsyncStorage.setItem(STORAGE_KEYS.API_KEY, cleanKey),
      AsyncStorage.setItem(STORAGE_KEYS.MODEL, model),
      AsyncStorage.setItem(STORAGE_KEYS.AUTO_SPEAK, String(autoSpeak)),
      AsyncStorage.setItem(STORAGE_KEYS.TRANSLIT, String(showTranslit)),
    ]);
    setSettingsOpen(false);
  };

  const speak = (text, dir) => {
    if (!text) return;
    Speech.stop();
    Speech.speak(text, {
      language: dir === 'ru-hi' ? 'hi-IN' : 'ru-RU',
      rate: 0.95,
    });
  };

  const copyToClipboard = async (text) => {
    await Clipboard.setStringAsync(text);
    Alert.alert('Скопировано', 'Перевод скопирован в буфер обмена.');
  };

  const appendMessage = (entry) => {
    setMessages((prev) => [...prev, entry]);
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 120);
  };

  const updateMessage = (id, patch) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  };

  const toggleRecording = async (dir) => {
    if (!apiKey.trim()) {
      setSettingsOpen(true);
      return;
    }

    // Stop if currently recording
    if (recorderState.isRecording) {
      const finishedDir = activeDir || dir;
      setActiveDir(null);
      setBusy(true);

      const id = String(Date.now());
      const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      appendMessage({
        id,
        dir: finishedDir,
        source: 'Распознаю голос...',
        translated: '',
        translit: '',
        loading: true,
        error: '',
        time,
      });

      try {
        await audioRecorder.stop();
        const uri = audioRecorder.uri;
        if (!uri) throw new Error('Не удалось сохранить аудиозапись.');

        const base64Audio = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });

        const result = await transcribeAndTranslateAudio({
          base64Audio,
          mimeType: 'audio/mp4',
          direction: finishedDir,
          apiKey: apiKey.trim(),
          model,
          includeTranslit: showTranslit,
        });

        updateMessage(id, {
          source: result.transcript || '(Голосовое сообщение)',
          translated: result.translation,
          translit: result.translit,
          loading: false,
        });

        if (autoSpeak && result.translation) {
          speak(result.translation, finishedDir);
        }
      } catch (err) {
        updateMessage(id, {
          loading: false,
          error: err.message || 'Ошибка перевода',
        });
      } finally {
        setBusy(false);
      }
      return;
    }

    // Start new recording
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Нет доступа', 'Разрешите использование микрофона в настройках телефона.');
        return;
      }
      Speech.stop();
      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      setActiveDir(dir);
    } catch (err) {
      Alert.alert('Ошибка микрофона', err.message || 'Не удалось начать запись.');
    }
  };

  const handleManualSubmit = async () => {
    const clean = manualText.trim();
    if (!clean) return;
    if (!apiKey.trim()) {
      setSettingsOpen(true);
      return;
    }

    setManualText('');
    setBusy(true);
    const id = String(Date.now());
    const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

    appendMessage({
      id,
      dir: manualDir,
      source: clean,
      translated: '',
      translit: '',
      loading: true,
      error: '',
      time,
    });

    try {
      const result = await translateText({
        text: clean,
        direction: manualDir,
        apiKey: apiKey.trim(),
        model,
        includeTranslit: showTranslit,
      });

      updateMessage(id, {
        translated: result.translation,
        translit: result.translit,
        loading: false,
      });

      if (autoSpeak && result.translation) {
        speak(result.translation, manualDir);
      }
    } catch (err) {
      updateMessage(id, {
        loading: false,
        error: err.message || 'Ошибка перевода',
      });
    } finally {
      setBusy(false);
    }
  };

  const renderMessage = ({ item }) => {
    const isRuToHi = item.dir === 'ru-hi';
    return (
      <View style={[styles.msgRow, isRuToHi ? styles.msgRight : styles.msgLeft]}>
        <View style={[styles.bubble, isRuToHi ? styles.bubbleRu : styles.bubbleHi]}>
          <View style={styles.bubbleHeader}>
            <Text style={[styles.dirLabel, isRuToHi ? styles.textLightMuted : styles.textDarkMuted]}>
              {isRuToHi ? 'ВЫ (RU → HI)' : 'СОБЕСЕДНИК (HI → RU)'}
            </Text>
            <Text style={[styles.timeLabel, isRuToHi ? styles.textLightMuted : styles.textDarkMuted]}>
              {item.time}
            </Text>
          </View>

          <Text style={[styles.sourceText, isRuToHi ? styles.textLightMuted : styles.textDarkMuted]}>
            {item.source}
          </Text>

          <View style={[styles.divider, isRuToHi ? styles.dividerLight : styles.dividerDark]} />

          {item.loading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator size="small" color={isRuToHi ? '#FFFFFF' : '#4F46E5'} />
              <Text style={[styles.loadingText, isRuToHi ? styles.textLight : styles.textDark]}>
                Перевожу через Gemini...
              </Text>
            </View>
          ) : item.error ? (
            <Text style={styles.errorText}>{item.error}</Text>
          ) : (
            <>
              <Text style={[styles.translatedText, isRuToHi ? styles.textLight : styles.textDark]}>
                {item.translated}
              </Text>
              {!!item.translit && (
                <Text style={[styles.translitText, isRuToHi ? styles.textLightMuted : styles.textDarkMuted]}>
                  {item.translit}
                </Text>
              )}
              <View style={styles.cardActions}>
                <Pressable
                  onPress={() => speak(item.translated, item.dir)}
                  style={[styles.smallBtn, isRuToHi ? styles.smallBtnLight : styles.smallBtnDark]}
                >
                  <Text style={[styles.smallBtnText, isRuToHi ? styles.textLight : styles.textDark]}>
                    Озвучить
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => copyToClipboard(item.translated)}
                  style={[styles.smallBtn, isRuToHi ? styles.smallBtnLight : styles.smallBtnDark]}
                >
                  <Text style={[styles.smallBtnText, isRuToHi ? styles.textLight : styles.textDark]}>
                    Копия
                  </Text>
                </Pressable>
              </View>
            </>
          )}
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <StatusBar style="dark" />

      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>RU ⇄ HI Переводчик</Text>
          <Text style={styles.subtitle}>Голосовой перевод через Gemini</Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable
            onPress={() => setSettingsOpen(true)}
            style={[styles.keyBadge, apiKey ? styles.keyBadgeOk : styles.keyBadgeWarn]}
          >
            <Text style={[styles.keyBadgeText, apiKey ? styles.keyTextOk : styles.keyTextWarn]}>
              {apiKey ? 'Настройки' : 'Нужен ключ'}
            </Text>
          </Pressable>
          {messages.length > 0 && (
            <Pressable onPress={() => setMessages([])} style={styles.clearBtn}>
              <Text style={styles.clearBtnText}>Очистить</Text>
            </Pressable>
          )}
        </View>
      </View>

      {/* Messages */}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
      >
        {messages.length === 0 ? (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyTitle}>Готов к диалогу</Text>
            <Text style={styles.emptySubtitle}>
              Нажмите кнопку ниже, скажите фразу и нажмите ещё раз, чтобы отправить аудио в Gemini и сразу получить перевод с озвучкой.
            </Text>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(item) => item.id}
            renderItem={renderMessage}
            contentContainerStyle={styles.listContent}
          />
        )}

        {/* Recording indicator */}
        {recorderState.isRecording && (
          <View style={styles.recBanner}>
            <View style={styles.recDot} />
            <Text style={styles.recText}>
              {activeDir === 'ru-hi'
                ? 'Запись (Русский)... Нажмите ещё раз для перевода'
                : 'Запись (Хинди)... Нажмите ещё раз для перевода'}
            </Text>
          </View>
        )}

        {/* Controls Footer */}
        <View style={styles.footer}>
          <View style={styles.micRow}>
            <Pressable
              disabled={busy || (recorderState.isRecording && activeDir !== 'ru-hi')}
              onPress={() => toggleRecording('ru-hi')}
              style={[
                styles.micBtn,
                styles.micRu,
                recorderState.isRecording && activeDir === 'ru-hi' && styles.micRecording,
              ]}
            >
              <Text style={styles.micBtnTitle}>
                {recorderState.isRecording && activeDir === 'ru-hi' ? 'Стоп и перевести' : 'Я говорю'}
              </Text>
              <Text style={styles.micBtnSub}>RU → HI</Text>
            </Pressable>

            <Pressable
              disabled={busy || (recorderState.isRecording && activeDir !== 'hi-ru')}
              onPress={() => toggleRecording('hi-ru')}
              style={[
                styles.micBtn,
                styles.micHi,
                recorderState.isRecording && activeDir === 'hi-ru' && styles.micRecording,
              ]}
            >
              <Text style={styles.micBtnTitle}>
                {recorderState.isRecording && activeDir === 'hi-ru' ? 'Стоп и перевести' : 'Собеседник'}
              </Text>
              <Text style={styles.micBtnSub}>HI → RU</Text>
            </Pressable>
          </View>

          <View style={styles.manualRow}>
            <Pressable
              onPress={() => setManualDir((d) => (d === 'ru-hi' ? 'hi-ru' : 'ru-hi'))}
              style={styles.dirToggle}
            >
              <Text style={styles.dirToggleText}>{manualDir === 'ru-hi' ? 'RU→HI' : 'HI→RU'}</Text>
            </Pressable>
            <TextInput
              style={styles.textInput}
              placeholder="Или введите текст вручную..."
              placeholderTextColor="#94A3B8"
              value={manualText}
              onChangeText={setManualText}
              onSubmitEditing={handleManualSubmit}
              returnKeyType="send"
            />
            <Pressable onPress={handleManualSubmit} disabled={busy} style={styles.sendBtn}>
              <Text style={styles.sendBtnText}>→</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>

      {/* Settings Modal */}
      <Modal visible={settingsOpen} animationType="slide" transparent>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Настройки Gemini API</Text>

            <Text style={styles.fieldLabel}>API ключ (Google AI Studio)</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="AIza..."
              placeholderTextColor="#94A3B8"
              value={apiKey}
              onChangeText={setApiKey}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />

            <Text style={styles.fieldLabel}>Модель</Text>
            <View style={styles.modelList}>
              {MODELS.map((m) => (
                <Pressable
                  key={m.id}
                  onPress={() => setModel(m.id)}
                  style={[styles.modelChip, model === m.id && styles.modelChipActive]}
                >
                  <Text style={[styles.modelChipText, model === m.id && styles.modelChipTextActive]}>
                    {m.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Озвучивать перевод автоматически</Text>
              <Switch value={autoSpeak} onValueChange={setAutoSpeak} />
            </View>

            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Показывать транслитерацию хинди</Text>
              <Switch value={showTranslit} onValueChange={setShowTranslit} />
            </View>

            <View style={styles.modalButtons}>
              <Pressable onPress={() => setSettingsOpen(false)} style={styles.cancelBtn}>
                <Text style={styles.cancelBtnText}>Закрыть</Text>
              </Pressable>
              <Pressable onPress={saveSettings} style={styles.saveBtn}>
                <Text style={styles.saveBtnText}>Сохранить</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <TranslatorScreen />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  title: { fontSize: 17, fontWeight: '700', color: '#0F172A' },
  subtitle: { fontSize: 12, color: '#64748B', marginTop: 2 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  keyBadge: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  keyBadgeOk: { backgroundColor: '#ECFDF5' },
  keyBadgeWarn: { backgroundColor: '#FFF1F2' },
  keyBadgeText: { fontSize: 12, fontWeight: '600' },
  keyTextOk: { color: '#047857' },
  keyTextWarn: { color: '#BE123C' },
  clearBtn: { paddingHorizontal: 8, paddingVertical: 6 },
  clearBtnText: { fontSize: 12, color: '#64748B', fontWeight: '500' },
  emptyBox: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 28 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: '#1E293B', marginBottom: 8 },
  emptySubtitle: { fontSize: 14, color: '#64748B', textAlign: 'center', lineHeight: 20 },
  listContent: { padding: 14, gap: 12 },
  msgRow: { width: '100%', flexDirection: 'row' },
  msgRight: { justifyContent: 'flex-end' },
  msgLeft: { justifyContent: 'flex-start' },
  bubble: { maxWidth: '88%', borderRadius: 18, padding: 14 },
  bubbleRu: { backgroundColor: '#4F46E5' },
  bubbleHi: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2E8F0' },
  bubbleHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, marginBottom: 6 },
  dirLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.4 },
  timeLabel: { fontSize: 10 },
  sourceText: { fontSize: 13, lineHeight: 18 },
  divider: { height: 1, marginVertical: 8 },
  dividerLight: { backgroundColor: 'rgba(255,255,255,0.22)' },
  dividerDark: { backgroundColor: '#F1F5F9' },
  translatedText: { fontSize: 16, fontWeight: '600', lineHeight: 22 },
  translitText: { fontSize: 12, fontStyle: 'italic', marginTop: 4 },
  textLight: { color: '#FFFFFF' },
  textLightMuted: { color: '#E0E7FF' },
  textDark: { color: '#0F172A' },
  textDarkMuted: { color: '#64748B' },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  loadingText: { fontSize: 13 },
  errorText: { fontSize: 13, color: '#FECDD3' },
  cardActions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  smallBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  smallBtnLight: { backgroundColor: 'rgba(255,255,255,0.18)' },
  smallBtnDark: { backgroundColor: '#F1F5F9' },
  smallBtnText: { fontSize: 12, fontWeight: '600' },
  recBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FEF2F2',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#FECACA',
  },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#EF4444' },
  recText: { fontSize: 12, fontWeight: '600', color: '#B91C1C' },
  footer: {
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
    padding: 12,
    gap: 10,
  },
  micRow: { flexDirection: 'row', gap: 10 },
  micBtn: {
    flex: 1,
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 14,
    alignItems: 'center',
  },
  micRu: { backgroundColor: '#4F46E5' },
  micHi: { backgroundColor: '#F97316' },
  micRecording: { backgroundColor: '#DC2626' },
  micBtnTitle: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  micBtnSub: { color: 'rgba(255,255,255,0.85)', fontSize: 11, marginTop: 2, fontWeight: '600' },
  manualRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dirToggle: {
    backgroundColor: '#F1F5F9',
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: 10,
  },
  dirToggleText: { fontSize: 12, fontWeight: '700', color: '#334155' },
  textInput: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
    color: '#0F172A',
  },
  sendBtn: {
    backgroundColor: '#0F172A',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
  },
  sendBtnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.5)',
    justifyContent: 'center',
    padding: 20,
  },
  modalCard: { backgroundColor: '#FFFFFF', borderRadius: 20, padding: 20 },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#0F172A', marginBottom: 14 },
  fieldLabel: { fontSize: 12, fontWeight: '600', color: '#475569', marginBottom: 6 },
  modalInput: {
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#0F172A',
    marginBottom: 14,
  },
  modelList: { gap: 6, marginBottom: 14 },
  modelChip: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    backgroundColor: '#F8FAFC',
  },
  modelChipActive: { borderColor: '#4F46E5', backgroundColor: '#EEF2FF' },
  modelChipText: { fontSize: 13, color: '#334155' },
  modelChipTextActive: { color: '#4338CA', fontWeight: '600' },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
  },
  switchLabel: { fontSize: 13, color: '#1E293B', flex: 1, paddingRight: 10 },
  modalButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 14 },
  cancelBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, backgroundColor: '#F1F5F9' },
  cancelBtnText: { fontSize: 14, fontWeight: '600', color: '#475569' },
  saveBtn: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10, backgroundColor: '#4F46E5' },
  saveBtnText: { fontSize: 14, fontWeight: '600', color: '#FFFFFF' },
});

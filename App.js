import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
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

const EMBEDDED_API_KEY = (process.env.EXPO_PUBLIC_GEMINI_API_KEY || '').trim();
const EMBEDDED_BASE_URL = (process.env.EXPO_PUBLIC_API_BASE_URL || '').trim();

const STORAGE_KEYS = {
  API_KEY: '@ru_hi_gemini_api_key',
  BASE_URL: '@ru_hi_api_base_url',
  MODEL: '@ru_hi_gemini_model',
  AUTO_SPEAK: '@ru_hi_auto_speak',
  TRANSLIT: '@ru_hi_translit',
};

const MODELS = [
  { id: 'gemini-3.8-flash', title: 'Gemini 3.8 Flash', subtitle: 'Оптимальный баланс скорости и точности' },
  { id: 'gemini-3.5-flash-lite', title: 'Gemini 3.5 Flash-Lite', subtitle: 'Максимально быстрый ответ' },
  { id: 'gemini-2.5-flash', title: 'Gemini 2.5 Flash', subtitle: 'Классическая стабильная модель' },
];

const QUICK_PHRASES = [
  'Привет! Как дела?',
  'Сколько это стоит?',
  'Спасибо, всё понятно',
  'Повторите, пожалуйста, помедленнее',
];

function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function TranslatorScreen() {
  const [apiKey, setApiKey] = useState(EMBEDDED_API_KEY);
  const [baseUrl, setBaseUrl] = useState(EMBEDDED_BASE_URL);
  const [model, setModel] = useState('gemini-3.8-flash');
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [showTranslit, setShowTranslit] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [messages, setMessages] = useState([]);
  const [activeDir, setActiveDir] = useState(null); // 'ru-hi' | 'hi-ru' | null
  const [manualDir, setManualDir] = useState('ru-hi');
  const [manualText, setManualText] = useState('');
  const [busy, setBusy] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [recSeconds, setRecSeconds] = useState(0);
  const [copiedId, setCopiedId] = useState(null);

  const listRef = useRef(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(audioRecorder);

  // Smooth recording pulse + timer
  useEffect(() => {
    let interval = null;
    let loop = null;

    if (recorderState.isRecording) {
      setRecSeconds(0);
      interval = setInterval(() => setRecSeconds((s) => s + 1), 1000);
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.07,
            duration: 650,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 650,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );
      loop.start();
    } else {
      pulseAnim.setValue(1);
    }

    return () => {
      if (interval) clearInterval(interval);
      if (loop) loop.stop();
    };
  }, [recorderState.isRecording, pulseAnim]);

  // Keyboard listener for Android lift
  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', (e) => {
      if (Platform.OS === 'android') {
        setKeyboardHeight(e.endCoordinates?.height || 0);
      }
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      if (Platform.OS === 'android') {
        setKeyboardHeight(0);
      }
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Load saved settings + request mic permission
  useEffect(() => {
    (async () => {
      try {
        const [savedKey, savedUrl, savedModel, savedSpeak, savedTranslit] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEYS.API_KEY),
          AsyncStorage.getItem(STORAGE_KEYS.BASE_URL),
          AsyncStorage.getItem(STORAGE_KEYS.MODEL),
          AsyncStorage.getItem(STORAGE_KEYS.AUTO_SPEAK),
          AsyncStorage.getItem(STORAGE_KEYS.TRANSLIT),
        ]);
        const effectiveKey = (savedKey || EMBEDDED_API_KEY).trim();
        const effectiveUrl = (savedUrl || EMBEDDED_BASE_URL).trim();

        setApiKey(effectiveKey);
        setBaseUrl(effectiveUrl);

        if (!effectiveKey && !effectiveUrl) {
          setSettingsOpen(true);
        }
        if (savedModel) setModel(savedModel);
        if (savedSpeak !== null) setAutoSpeak(savedSpeak === 'true');
        if (savedTranslit !== null) setShowTranslit(savedTranslit === 'true');
      } catch {
        if (!EMBEDDED_API_KEY && !EMBEDDED_BASE_URL) {
          setSettingsOpen(true);
        }
      }

      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Доступ к микрофону', 'Разрешите доступ к микрофону в настройках устройства.');
      }
      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: true,
      });
    })();
  }, []);

  const hasCredentials = Boolean(apiKey.trim() || baseUrl.trim());

  const saveSettings = async () => {
    const cleanKey = apiKey.trim();
    const cleanUrl = baseUrl.trim();
    setApiKey(cleanKey);
    setBaseUrl(cleanUrl);
    await Promise.all([
      AsyncStorage.setItem(STORAGE_KEYS.API_KEY, cleanKey),
      AsyncStorage.setItem(STORAGE_KEYS.BASE_URL, cleanUrl),
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
      rate: 0.94,
    });
  };

  const copyToClipboard = async (id, text) => {
    await Clipboard.setStringAsync(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId((curr) => (curr === id ? null : curr)), 1600);
  };

  const appendMessage = (entry) => {
    setMessages((prev) => [...prev, entry]);
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 120);
  };

  const updateMessage = (id, patch) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  };

  const toggleRecording = async (dir) => {
    if (!hasCredentials) {
      setSettingsOpen(true);
      return;
    }

    if (recorderState.isRecording) {
      const finishedDir = activeDir || dir;
      setActiveDir(null);
      setBusy(true);

      const id = String(Date.now());
      const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      appendMessage({
        id,
        dir: finishedDir,
        source: 'Распознавание речи…',
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
          baseUrl: baseUrl.trim(),
          model,
          includeTranslit: showTranslit,
        });

        updateMessage(id, {
          source: result.transcript || 'Голосовое сообщение',
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
          error: err.message || 'Не удалось выполнить перевод',
        });
      } finally {
        setBusy(false);
      }
      return;
    }

    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Нет доступа', 'Разрешите использование микрофона в настройках устройства.');
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

  const sendTextMessage = async (rawText, dir = manualDir) => {
    const clean = rawText.trim();
    if (!clean) return;
    if (!hasCredentials) {
      setSettingsOpen(true);
      return;
    }

    setManualText('');
    setBusy(true);
    const id = String(Date.now());
    const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

    appendMessage({
      id,
      dir,
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
        direction: dir,
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim(),
        model,
        includeTranslit: showTranslit,
      });

      updateMessage(id, {
        translated: result.translation,
        translit: result.translit,
        loading: false,
      });

      if (autoSpeak && result.translation) {
        speak(result.translation, dir);
      }
    } catch (err) {
      updateMessage(id, {
        loading: false,
        error: err.message || 'Не удалось выполнить перевод',
      });
    } finally {
      setBusy(false);
    }
  };

  const renderMessage = ({ item }) => {
    const isRuToHi = item.dir === 'ru-hi';
    const isCopied = copiedId === item.id;

    return (
      <View style={[styles.msgRow, isRuToHi ? styles.msgRight : styles.msgLeft]}>
        <View style={[styles.card, isRuToHi ? styles.cardBlue : styles.cardWhite]}>
          <View style={styles.cardTop}>
            <Text style={[styles.langTag, isRuToHi ? styles.langTagLight : styles.langTagDark]}>
              {isRuToHi ? 'Русский → Хинди' : 'Хинди → Русский'}
            </Text>
            <Text style={[styles.timeText, isRuToHi ? styles.textLightSub : styles.textDarkSub]}>
              {item.time}
            </Text>
          </View>

          <Text style={[styles.sourceText, isRuToHi ? styles.textLightSub : styles.textDarkSub]}>
            {item.source}
          </Text>

          <View style={[styles.hairline, isRuToHi ? styles.hairlineLight : styles.hairlineDark]} />

          {item.loading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator size="small" color={isRuToHi ? '#FFFFFF' : '#007AFF'} />
              <Text style={[styles.loadingText, isRuToHi ? styles.textLight : styles.textDark]}>
                Перевожу…
              </Text>
            </View>
          ) : item.error ? (
            <View style={[styles.errorPill, isRuToHi && styles.errorPillOnBlue]}>
              <Ionicons name="alert-circle" size={16} color={isRuToHi ? '#FFE5E5' : '#FF3B30'} />
              <Text style={[styles.errorText, isRuToHi ? styles.textLight : styles.errorTextRed]}>
                {item.error}
              </Text>
            </View>
          ) : (
            <>
              <Text style={[styles.translatedText, isRuToHi ? styles.textLight : styles.textDark]}>
                {item.translated}
              </Text>
              {!!item.translit && (
                <Text style={[styles.translitText, isRuToHi ? styles.textLightSub : styles.textDarkSub]}>
                  {item.translit}
                </Text>
              )}

              <View style={styles.actionRow}>
                <Pressable
                  onPress={() => speak(item.translated, item.dir)}
                  style={({ pressed }) => [
                    styles.iconAction,
                    isRuToHi ? styles.iconActionLight : styles.iconActionDark,
                    pressed && styles.pressedOpacity,
                  ]}
                >
                  <Ionicons name="volume-high" size={15} color={isRuToHi ? '#FFFFFF' : '#007AFF'} />
                  <Text style={[styles.iconActionText, isRuToHi ? styles.textLight : styles.textBlue]}>
                    Озвучить
                  </Text>
                </Pressable>

                <Pressable
                  onPress={() => copyToClipboard(item.id, item.translated)}
                  style={({ pressed }) => [
                    styles.iconAction,
                    isRuToHi ? styles.iconActionLight : styles.iconActionDark,
                    pressed && styles.pressedOpacity,
                  ]}
                >
                  <Ionicons
                    name={isCopied ? 'checkmark' : 'copy-outline'}
                    size={15}
                    color={isRuToHi ? '#FFFFFF' : '#3C3C43'}
                  />
                  <Text style={[styles.iconActionText, isRuToHi ? styles.textLight : styles.textDark]}>
                    {isCopied ? 'Скопировано' : 'Копия'}
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
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <StatusBar style="dark" />

      {/* Apple Large-Title Navigation Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.largeTitle}>Переводчик</Text>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, hasCredentials ? styles.dotGreen : styles.dotRed]} />
            <Text style={styles.statusText}>
              {!hasCredentials
                ? 'Укажите ключ в настройках'
                : baseUrl
                ? 'Русский ⇄ Хинди · Прокси'
                : 'Русский ⇄ Хинди · Gemini'}
            </Text>
          </View>
        </View>

        <View style={styles.headerButtons}>
          {messages.length > 0 && (
            <Pressable
              onPress={() => setMessages([])}
              style={({ pressed }) => [styles.circleBtn, pressed && styles.pressedOpacity]}
            >
              <Ionicons name="trash-outline" size={18} color="#3C3C43" />
            </Pressable>
          )}
          <Pressable
            onPress={() => setSettingsOpen(true)}
            style={({ pressed }) => [styles.circleBtn, pressed && styles.pressedOpacity]}
          >
            <Ionicons name="settings-outline" size={19} color="#007AFF" />
          </Pressable>
        </View>
      </View>

      {/* Main Content + Floating Dock */}
      <KeyboardAvoidingView
        style={[styles.flex, Platform.OS === 'android' && keyboardHeight > 0 && { paddingBottom: keyboardHeight }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {messages.length === 0 ? (
          <ScrollView contentContainerStyle={styles.emptyScroll} keyboardShouldPersistTaps="handled">
            <View style={styles.heroCard}>
              <View style={styles.heroIconWrap}>
                <Ionicons name="language" size={28} color="#007AFF" />
              </View>
              <Text style={styles.heroTitle}>Живой диалог RU ⇄ HI</Text>
              <Text style={styles.heroSubtitle}>
                Нажмите на микрофон внизу, произнесите фразу и нажмите ещё раз — перевод сразу появится и прозвучит вслух.
              </Text>
            </View>

            <Text style={styles.sectionCaption}>БЫСТРЫЕ ФРАЗЫ</Text>
            <View style={styles.quickGroup}>
              {QUICK_PHRASES.map((phrase, idx) => (
                <Pressable
                  key={phrase}
                  disabled={busy}
                  onPress={() => sendTextMessage(phrase, 'ru-hi')}
                  style={({ pressed }) => [
                    styles.quickRow,
                    idx < QUICK_PHRASES.length - 1 && styles.quickRowBorder,
                    pressed && styles.quickRowPressed,
                  ]}
                >
                  <Text style={styles.quickText}>{phrase}</Text>
                  <Ionicons name="chevron-forward" size={16} color="#C7C7CC" />
                </Pressable>
              ))}
            </View>
          </ScrollView>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(item) => item.id}
            renderItem={renderMessage}
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
          />
        )}

        {/* Active Recording Pill */}
        {recorderState.isRecording && (
          <View style={styles.recPillWrap}>
            <View style={styles.recPill}>
              <View style={styles.recLiveDot} />
              <Text style={styles.recPillText}>
                {activeDir === 'ru-hi' ? 'Слушаю русский' : 'Слушаю хинди'} · {formatDuration(recSeconds)}
              </Text>
            </View>
          </View>
        )}

        {/* Apple-style Floating Bottom Dock */}
        <View style={styles.dock}>
          {keyboardHeight === 0 && (
            <View style={styles.micGrid}>
              <Animated.View
                style={[
                  styles.flex,
                  recorderState.isRecording && activeDir === 'ru-hi' && { transform: [{ scale: pulseAnim }] },
                ]}
              >
                <Pressable
                  disabled={busy || (recorderState.isRecording && activeDir !== 'ru-hi')}
                  onPress={() => toggleRecording('ru-hi')}
                  style={({ pressed }) => [
                    styles.micPad,
                    styles.micPadBlue,
                    recorderState.isRecording && activeDir === 'ru-hi' && styles.micPadRecording,
                    pressed && styles.pressedScale,
                  ]}
                >
                  <View style={styles.micCircleWhite}>
                    <Ionicons
                      name={recorderState.isRecording && activeDir === 'ru-hi' ? 'stop' : 'mic'}
                      size={22}
                      color={recorderState.isRecording && activeDir === 'ru-hi' ? '#FF3B30' : '#007AFF'}
                    />
                  </View>
                  <View style={styles.micLabels}>
                    <Text style={styles.micPrimaryLight}>
                      {recorderState.isRecording && activeDir === 'ru-hi' ? 'Готово' : 'Русский'}
                    </Text>
                    <Text style={styles.micSecondaryLight}>Я говорю</Text>
                  </View>
                </Pressable>
              </Animated.View>

              <Animated.View
                style={[
                  styles.flex,
                  recorderState.isRecording && activeDir === 'hi-ru' && { transform: [{ scale: pulseAnim }] },
                ]}
              >
                <Pressable
                  disabled={busy || (recorderState.isRecording && activeDir !== 'hi-ru')}
                  onPress={() => toggleRecording('hi-ru')}
                  style={({ pressed }) => [
                    styles.micPad,
                    styles.micPadWhite,
                    recorderState.isRecording && activeDir === 'hi-ru' && styles.micPadRecording,
                    pressed && styles.pressedScale,
                  ]}
                >
                  <View
                    style={[
                      styles.micCircleSoft,
                      recorderState.isRecording && activeDir === 'hi-ru' && styles.micCircleWhite,
                    ]}
                  >
                    <Ionicons
                      name={recorderState.isRecording && activeDir === 'hi-ru' ? 'stop' : 'mic'}
                      size={22}
                      color={recorderState.isRecording && activeDir === 'hi-ru' ? '#FF3B30' : '#1C1C1E'}
                    />
                  </View>
                  <View style={styles.micLabels}>
                    <Text
                      style={[
                        styles.micPrimaryDark,
                        recorderState.isRecording && activeDir === 'hi-ru' && styles.textLight,
                      ]}
                    >
                      {recorderState.isRecording && activeDir === 'hi-ru' ? 'Готово' : 'हिन्दी'}
                    </Text>
                    <Text
                      style={[
                        styles.micSecondaryDark,
                        recorderState.isRecording && activeDir === 'hi-ru' && styles.micSecondaryLight,
                      ]}
                    >
                      Собеседник
                    </Text>
                  </View>
                </Pressable>
              </Animated.View>
            </View>
          )}

          {/* iMessage-style Capsule Input */}
          <View style={styles.inputCapsule}>
            <Pressable
              onPress={() => setManualDir((d) => (d === 'ru-hi' ? 'hi-ru' : 'ru-hi'))}
              style={({ pressed }) => [styles.dirPill, pressed && styles.pressedOpacity]}
            >
              <Text style={styles.dirPillText}>{manualDir === 'ru-hi' ? 'RU→HI' : 'HI→RU'}</Text>
            </Pressable>

            <TextInput
              style={styles.capsuleInput}
              placeholder="Написать сообщение…"
              placeholderTextColor="#8E8E93"
              value={manualText}
              onChangeText={setManualText}
              onSubmitEditing={() => sendTextMessage(manualText, manualDir)}
              returnKeyType="send"
            />

            <Pressable
              onPress={() => sendTextMessage(manualText, manualDir)}
              disabled={busy || !manualText.trim()}
              style={({ pressed }) => [
                styles.sendCircle,
                (!manualText.trim() || busy) && styles.sendCircleDisabled,
                pressed && styles.pressedOpacity,
              ]}
            >
              <Ionicons name="arrow-up" size={18} color="#FFFFFF" />
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>

      {/* iOS Bottom-Sheet Settings Modal */}
      <Modal visible={settingsOpen} animationType="slide" transparent>
        <View style={styles.sheetBackdrop}>
          <Pressable style={styles.flex} onPress={() => setSettingsOpen(false)} />
          <View style={styles.sheetContainer}>
            <View style={styles.sheetGrabber} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Настройки</Text>
              <Pressable onPress={() => setSettingsOpen(false)} style={styles.sheetCloseBtn}>
                <Ionicons name="close" size={18} color="#3C3C43" />
              </Pressable>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <Text style={styles.groupHeader}>ПОДКЛЮЧЕНИЕ</Text>
              <View style={styles.insetGroup}>
                <View style={styles.inputGroupRow}>
                  <Text style={styles.rowLabel}>Gemini API ключ</Text>
                  <TextInput
                    style={styles.sheetInput}
                    placeholder="AIza…"
                    placeholderTextColor="#AEAEB2"
                    value={apiKey}
                    onChangeText={setApiKey}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry
                  />
                </View>
                <View style={styles.groupDivider} />
                <View style={styles.inputGroupRow}>
                  <Text style={styles.rowLabel}>Прокси URL (без VPN)</Text>
                  <TextInput
                    style={styles.sheetInput}
                    placeholder="https://…workers.dev"
                    placeholderTextColor="#AEAEB2"
                    value={baseUrl}
                    onChangeText={setBaseUrl}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
              </View>

              <Text style={styles.groupHeader}>МОДЕЛЬ</Text>
              <View style={styles.insetGroup}>
                {MODELS.map((m, idx) => {
                  const selected = model === m.id;
                  return (
                    <React.Fragment key={m.id}>
                      <Pressable onPress={() => setModel(m.id)} style={styles.modelRow}>
                        <View style={styles.flex}>
                          <Text style={styles.modelTitle}>{m.title}</Text>
                          <Text style={styles.modelSub}>{m.subtitle}</Text>
                        </View>
                        {selected && <Ionicons name="checkmark" size={20} color="#007AFF" />}
                      </Pressable>
                      {idx < MODELS.length - 1 && <View style={styles.groupDivider} />}
                    </React.Fragment>
                  );
                })}
              </View>

              <Text style={styles.groupHeader}>ОЗВУЧКА И ОТОБРАЖЕНИЕ</Text>
              <View style={styles.insetGroup}>
                <View style={styles.switchGroupRow}>
                  <Text style={styles.rowLabel}>Озвучивать перевод сразу</Text>
                  <Switch
                    value={autoSpeak}
                    onValueChange={setAutoSpeak}
                    trackColor={{ false: '#E5E5EA', true: '#34C759' }}
                    thumbColor="#FFFFFF"
                  />
                </View>
                <View style={styles.groupDivider} />
                <View style={styles.switchGroupRow}>
                  <Text style={styles.rowLabel}>Транслитерация хинди</Text>
                  <Switch
                    value={showTranslit}
                    onValueChange={setShowTranslit}
                    trackColor={{ false: '#E5E5EA', true: '#34C759' }}
                    thumbColor="#FFFFFF"
                  />
                </View>
              </View>

              <Pressable
                onPress={saveSettings}
                style={({ pressed }) => [styles.primarySheetBtn, pressed && styles.pressedOpacity]}
              >
                <Text style={styles.primarySheetBtnText}>Готово</Text>
              </Pressable>
            </ScrollView>
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
  screen: { flex: 1, backgroundColor: '#F2F2F7' },
  flex: { flex: 1 },

  // Header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
    backgroundColor: '#F2F2F7',
  },
  headerLeft: { flex: 1 },
  largeTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: '#000000',
    letterSpacing: -0.6,
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  dotGreen: { backgroundColor: '#34C759' },
  dotRed: { backgroundColor: '#FF3B30' },
  statusText: { fontSize: 13, color: '#8E8E93', fontWeight: '500' },
  headerButtons: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  circleBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },

  // Empty state
  emptyScroll: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 24 },
  heroCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 24,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
    marginBottom: 24,
  },
  heroIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: '#EAF3FF',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  heroTitle: { fontSize: 19, fontWeight: '700', color: '#1C1C1E', letterSpacing: -0.3 },
  heroSubtitle: {
    fontSize: 14,
    color: '#6E6E73',
    textAlign: 'center',
    lineHeight: 20,
    marginTop: 6,
  },
  sectionCaption: {
    fontSize: 12,
    fontWeight: '600',
    color: '#8E8E93',
    letterSpacing: 0.5,
    marginLeft: 12,
    marginBottom: 8,
  },
  quickGroup: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.03,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  quickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  quickRowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E5E5EA' },
  quickRowPressed: { backgroundColor: '#F2F2F7' },
  quickText: { fontSize: 15, color: '#1C1C1E', fontWeight: '400' },

  // Chat list
  listContent: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 20, gap: 12 },
  msgRow: { width: '100%', flexDirection: 'row' },
  msgRight: { justifyContent: 'flex-end' },
  msgLeft: { justifyContent: 'flex-start' },
  card: {
    maxWidth: '88%',
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 14,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  cardBlue: { backgroundColor: '#007AFF', borderBottomRightRadius: 6 },
  cardWhite: { backgroundColor: '#FFFFFF', borderBottomLeftRadius: 6 },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 14, marginBottom: 4 },
  langTag: { fontSize: 11, fontWeight: '600', letterSpacing: 0.1 },
  langTagLight: { color: 'rgba(255,255,255,0.78)' },
  langTagDark: { color: '#8E8E93' },
  timeText: { fontSize: 11 },
  sourceText: { fontSize: 14, lineHeight: 19 },
  hairline: { height: StyleSheet.hairlineWidth, marginVertical: 10 },
  hairlineLight: { backgroundColor: 'rgba(255,255,255,0.28)' },
  hairlineDark: { backgroundColor: '#E5E5EA' },
  translatedText: { fontSize: 18, fontWeight: '600', lineHeight: 24, letterSpacing: -0.2 },
  translitText: { fontSize: 13, marginTop: 4, lineHeight: 18 },
  textLight: { color: '#FFFFFF' },
  textLightSub: { color: 'rgba(255,255,255,0.82)' },
  textDark: { color: '#1C1C1E' },
  textDarkSub: { color: '#6E6E73' },
  textBlue: { color: '#007AFF' },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 },
  loadingText: { fontSize: 14, fontWeight: '500' },
  errorPill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 },
  errorPillOnBlue: { opacity: 0.95 },
  errorText: { fontSize: 13, flex: 1, lineHeight: 18 },
  errorTextRed: { color: '#FF3B30' },
  actionRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  iconAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
  },
  iconActionLight: { backgroundColor: 'rgba(255,255,255,0.2)' },
  iconActionDark: { backgroundColor: '#F2F2F7' },
  iconActionText: { fontSize: 12, fontWeight: '600' },

  // Recording pill
  recPillWrap: { alignItems: 'center', paddingBottom: 8 },
  recPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#1C1C1E',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
  },
  recLiveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#FF3B30' },
  recPillText: { color: '#FFFFFF', fontSize: 12, fontWeight: '600' },

  // Bottom dock
  dock: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
    gap: 12,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: -4 },
    elevation: 10,
  },
  micGrid: { flexDirection: 'row', gap: 10 },
  micPad: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 20,
  },
  micPadBlue: { backgroundColor: '#007AFF' },
  micPadWhite: {
    backgroundColor: '#F2F2F7',
  },
  micPadRecording: { backgroundColor: '#FF3B30' },
  micCircleWhite: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  micCircleSoft: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  micLabels: { flex: 1 },
  micPrimaryLight: { color: '#FFFFFF', fontSize: 15, fontWeight: '700', letterSpacing: -0.2 },
  micSecondaryLight: { color: 'rgba(255,255,255,0.82)', fontSize: 12, fontWeight: '500', marginTop: 1 },
  micPrimaryDark: { color: '#1C1C1E', fontSize: 15, fontWeight: '700', letterSpacing: -0.2 },
  micSecondaryDark: { color: '#8E8E93', fontSize: 12, fontWeight: '500', marginTop: 1 },

  // iMessage capsule input
  inputCapsule: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F2F2F7',
    borderRadius: 24,
    paddingLeft: 6,
    paddingRight: 5,
    paddingVertical: 5,
    gap: 8,
  },
  dirPill: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 18,
  },
  dirPillText: { fontSize: 12, fontWeight: '700', color: '#007AFF' },
  capsuleInput: {
    flex: 1,
    fontSize: 15,
    color: '#1C1C1E',
    paddingVertical: 6,
  },
  sendCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#007AFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendCircleDisabled: { backgroundColor: '#C7C7CC' },

  // iOS Bottom Sheet Settings
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'flex-end',
  },
  sheetContainer: {
    backgroundColor: '#F2F2F7',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 28,
    maxHeight: '86%',
  },
  sheetGrabber: {
    width: 38,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#C7C7CC',
    alignSelf: 'center',
    marginBottom: 12,
  },
  sheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  sheetTitle: { fontSize: 20, fontWeight: '700', color: '#000000', letterSpacing: -0.4 },
  sheetCloseBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#E5E5EA',
    alignItems: 'center',
    justifyContent: 'center',
  },
  groupHeader: {
    fontSize: 12,
    fontWeight: '600',
    color: '#8E8E93',
    marginLeft: 12,
    marginBottom: 6,
    marginTop: 12,
  },
  insetGroup: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    overflow: 'hidden',
  },
  inputGroupRow: { paddingHorizontal: 14, paddingVertical: 10 },
  rowLabel: { fontSize: 15, color: '#1C1C1E', fontWeight: '500' },
  sheetInput: {
    fontSize: 14,
    color: '#007AFF',
    marginTop: 4,
    paddingVertical: 4,
  },
  groupDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#E5E5EA',
    marginLeft: 14,
  },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  modelTitle: { fontSize: 15, fontWeight: '500', color: '#1C1C1E' },
  modelSub: { fontSize: 12, color: '#8E8E93', marginTop: 2 },
  switchGroupRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  primarySheetBtn: {
    backgroundColor: '#007AFF',
    borderRadius: 16,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 20,
  },
  primarySheetBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  pressedOpacity: { opacity: 0.7 },
  pressedScale: { transform: [{ scale: 0.97 }] },
});

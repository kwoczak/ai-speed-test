import React, { useState, useEffect, useRef } from 'react';
import { Mic, Square, StopCircle } from 'lucide-react';
import './index.css';

const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY;
const ELEVENLABS_API_KEY = import.meta.env.VITE_ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = import.meta.env.VITE_ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB';

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [messages, setMessages] = useState([]);
  const [timer, setTimer] = useState(0);
  const [status, setStatus] = useState('Gotowy');
  
  const recognition = useRef(null);
  const audioContext = useRef(null);
  const nextPlayTime = useRef(0);
  const timerInterval = useRef(null);
  const startTime = useRef(0);
  const chatRef = useRef(null);
  
  const currentAbortController = useRef(null);
  const currentElevenLabsWs = useRef(null);

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    // Setup Web Speech API
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      recognition.current = new SpeechRecognition();
      recognition.current.lang = 'pl-PL';
      recognition.current.interimResults = false;
      recognition.current.maxAlternatives = 1;

      recognition.current.onresult = (event) => {
        const text = event.results[0][0].transcript;
        setMessages((prev) => [...prev, { role: 'user', content: text }]);
        
        startTime.current = Date.now();
        timerInterval.current = setInterval(() => {
          setTimer(Date.now() - startTime.current);
        }, 10);
        
        setIsRecording(false);
        setIsProcessing(true);
        setIsPlaying(false);
        setStatus('Wysyłanie zapytania...');
        
        processAudio(text);
      };

      recognition.current.onerror = (event) => {
        console.error('Speech recognition error', event.error);
        setIsRecording(false);
        setStatus('Błąd rozpoznawania mowy');
      };
      
      recognition.current.onend = () => {
        setIsRecording(false);
      };
    } else {
      setStatus('Brak wsparcia dla rozpoznawania mowy w Twojej przeglądarce.');
    }

    audioContext.current = new (window.AudioContext || window.webkitAudioContext)();

    return () => {
      if (timerInterval.current) clearInterval(timerInterval.current);
    };
  }, []);

  const processAudio = async (userText) => {
    try {
      setStatus('Przetwarzanie przez OpenAI...');
      
      // Setup ElevenLabs WebSocket
      const model = 'eleven_turbo_v2_5';
      const elevenLabsWsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream-input?model_id=${model}&output_format=pcm_16000`;
      
      const elevenLabsWs = new WebSocket(elevenLabsWsUrl);
      currentElevenLabsWs.current = elevenLabsWs;
      let elevenLabsReady = false;
      const textQueue = [];

      elevenLabsWs.onopen = () => {
        elevenLabsReady = true;
        elevenLabsWs.send(JSON.stringify({
          text: ' ',
          voice_settings: { stability: 0.5, similarity_boost: 0.8 },
          xi_api_key: ELEVENLABS_API_KEY,
        }));
        while (textQueue.length > 0) {
          const txt = textQueue.shift();
          elevenLabsWs.send(JSON.stringify({ text: txt, try_trigger_generation: true }));
        }
      };

      elevenLabsWs.onmessage = (event) => {
        const response = JSON.parse(event.data);
        if (response.audio) {
          if (timerInterval.current) {
            clearInterval(timerInterval.current);
            timerInterval.current = null;
          }
          setStatus('Odtwarzanie audio...');
          setIsProcessing(false);
          setIsPlaying(true);
          playAudioChunk(response.audio);
        }
        if (response.isFinal) {
          setStatus('Gotowy');
          setIsPlaying(false);
          elevenLabsWs.close();
        }
      };

      elevenLabsWs.onerror = (err) => console.error('ElevenLabs WS Error:', err);

      // Fetch from OpenAI Stream
      const abortController = new AbortController();
      currentAbortController.current = abortController;

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        signal: abortController.signal,
        body: JSON.stringify({
          model: 'gpt-5.5',
          messages: [
            { role: 'system', content: 'Jesteś niezwykle inteligentnym, błyskotliwym asystentem AI. Udzielaj trafnych, przemyślanych i mądrych odpowiedzi. Ponieważ komunikujesz się głosowo, Twoje wypowiedzi powinny być bardzo naturalne, zwięzłe i konwersacyjne (unikaj lania wody, zachowując przy tym wysoką merytorykę).' },
            { role: 'user', content: userText }
          ],
          stream: true
        })
      });

      if (!response.body) throw new Error('No response body from OpenAI');

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(line => line.trim() !== '');
        
        for (const line of lines) {
          if (line === 'data: [DONE]') break;
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              const content = data.choices[0]?.delta?.content || '';
              if (content) {
                setMessages((prev) => {
                  const newMessages = [...prev];
                  const lastMessage = newMessages[newMessages.length - 1];
                  if (lastMessage && lastMessage.role === 'assistant') {
                    newMessages[newMessages.length - 1] = {
                      ...lastMessage,
                      content: lastMessage.content + content
                    };
                  } else {
                    newMessages.push({ role: 'assistant', content: content });
                  }
                  return newMessages;
                });
                
                if (elevenLabsReady) {
                  elevenLabsWs.send(JSON.stringify({ text: content, try_trigger_generation: true }));
                } else {
                  textQueue.push(content);
                }
              }
            } catch (e) {
              console.error('Error parsing stream chunk', e);
            }
          }
        }
      }

      // Close streams
      if (elevenLabsReady && elevenLabsWs.readyState === WebSocket.OPEN) {
        elevenLabsWs.send(JSON.stringify({ text: '' }));
      } else {
        textQueue.push('');
      }

    } catch (err) {
      if (err.name === 'AbortError') {
        console.log('Zatrzymano pobieranie z OpenAI');
      } else {
        console.error('Error processing:', err);
        setStatus('Wystąpił błąd');
        setIsProcessing(false);
        setIsPlaying(false);
      }
    }
  };

  const playAudioChunk = async (base64Audio) => {
    try {
      if (!audioContext.current || audioContext.current.state === 'closed') return;
      if (audioContext.current.state === 'suspended') {
        await audioContext.current.resume();
      }

      const binaryString = window.atob(base64Audio);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const int16Array = new Int16Array(bytes.buffer);
      const float32Array = new Float32Array(int16Array.length);
      for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 32768.0;
      }

      const audioBuffer = audioContext.current.createBuffer(1, float32Array.length, 16000);
      audioBuffer.getChannelData(0).set(float32Array);

      const source = audioContext.current.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.current.destination);

      const currentTime = audioContext.current.currentTime;
      if (nextPlayTime.current < currentTime) {
        nextPlayTime.current = currentTime + 0.05;
      }

      source.start(nextPlayTime.current);
      nextPlayTime.current += audioBuffer.duration;
    } catch (err) {
      console.error('Error playing audio chunk:', err);
    }
  };

  const toggleRecording = () => {
    if (!recognition.current) return;
    
    // Auto-stop previous playback if starting new record
    stopPlayback();

    if (isRecording) {
      recognition.current.stop();
      setIsRecording(false);
    } else {
      setTimer(0);
      nextPlayTime.current = audioContext.current ? audioContext.current.currentTime : 0;
      recognition.current.start();
      setIsRecording(true);
      setStatus('Słucham...');
    }
  };

  const stopPlayback = () => {
    if (currentAbortController.current) {
      currentAbortController.current.abort();
    }
    if (currentElevenLabsWs.current) {
      currentElevenLabsWs.current.close();
    }
    if (audioContext.current && audioContext.current.state !== 'closed') {
      audioContext.current.close();
      audioContext.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    nextPlayTime.current = 0;
    setStatus('Gotowy');
    setIsProcessing(false);
    setIsPlaying(false);
  };

  const formatTime = (ms) => {
    const totalSeconds = ms / 1000;
    return totalSeconds.toFixed(2) + ' s';
  };

  return (
    <div className="app-container">
      <div className="header">
        <h1>Voice Chat AI</h1>
        <div className="timer-label">Latency Time</div>
        <div className="timer-display">{formatTime(timer)}</div>
      </div>
      
      <div className="chat-window" ref={chatRef}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', marginTop: 'auto', marginBottom: 'auto' }}>
            Naciśnij mikrofon i powiedz coś...
          </div>
        )}
        {messages.map((msg, idx) => (
          <div key={idx} className={`message ${msg.role}`}>
            {msg.content}
          </div>
        ))}
      </div>

      <div className="controls">
        <div className="status-text">{status}</div>
        <div style={{ display: 'flex', gap: '20px', justifyContent: 'center' }}>
          <button 
            className={`mic-button ${isRecording ? 'recording' : ''} ${isProcessing && !isPlaying ? 'processing' : ''}`}
            onClick={toggleRecording}
            disabled={isProcessing && !isPlaying}
          >
            {isRecording ? <Square size={32} /> : <Mic size={32} />}
          </button>

          <button
            className="stop-button"
            onClick={stopPlayback}
            disabled={!isProcessing && !isPlaying}
            title="Przerwij odtwarzanie i przetwarzanie"
          >
            <StopCircle size={32} />
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;

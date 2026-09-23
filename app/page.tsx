'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { QRCodeSVG } from 'qrcode.react';

// 効果音再生
const playTone = (type: string) => {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    const now = ctx.currentTime;

    if (type === 'correct') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now);
      osc.frequency.setValueAtTime(659.25, now + 0.08);
      osc.frequency.setValueAtTime(783.99, now + 0.16);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
      osc.start(now);
      osc.stop(now + 0.35);
    } else if (type === 'wrong') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.setValueAtTime(164.81, now + 0.15);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
      osc.start(now);
      osc.stop(now + 0.4);
    } else if (type === 'tick') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
      osc.start(now);
      osc.stop(now + 0.05);
    }
  } catch (e) {}
};

export default function MultiPlayerQuizApp() {
  const [stage, setStage] = useState<'home' | 'lobby' | 'playing' | 'final_result'>('home');
  const [userName, setUserName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [inputCode, setInputCode] = useState('');
  const [isHost, setIsHost] = useState(false);
  const [players, setPlayers] = useState<any[]>([]);

  // クイズ設定
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [questionCount, setQuestionCount] = useState(5);
  const [questions, setQuestions] = useState<any[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [questionSource, setQuestionSource] = useState('');

  // プレイ中状態
  const [timeLeft, setTimeLeft] = useState(15);
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [isAnswered, setIsAnswered] = useState(false);
  const [combo, setCombo] = useState(0);

  const channelRef = useRef<any>(null);
  const timerRef = useRef<any>(null);
  const playerIdRef = useRef('');

  useEffect(() => {
    playerIdRef.current = 'player_' + Math.random().toString(36).substring(2, 9);
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const codeFromUrl = params.get('room');
      if (codeFromUrl && /^\d{4}$/.test(codeFromUrl)) {
        setInputCode(codeFromUrl);
      }
    }
  }, []);

  // ブロードキャスト送信
  const broadcastMessage = (event: string, payload: any) => {
    if (!channelRef.current) return;
    try {
      channelRef.current.send({
        type: 'broadcast',
        event,
        payload,
      });
    } catch (e) {
      console.warn('Realtime送信失敗:', e);
    }
  };

  // ゲーム開始共通処理
  const startQuizGame = (qList: any[], src: string) => {
    if (!qList || qList.length === 0) {
      alert('問題データが空です');
      return;
    }
    setQuestions(qList);
    setQuestionSource(src || 'OpenTDB');
    setCurrentIndex(0);
    setSelectedOption(null);
    setIsAnswered(false);
    setCombo(0);
    setTimeLeft(15);
    setStage('playing');
  };

  const connectToRoom = (code: string, hostFlag: boolean, initialUserName: string) => {
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
    }

    const channel = supabase.channel(`quiz-room-${code}`, {
      config: {
        broadcast: { self: true },
      },
    });

    channel
      .on('broadcast', { event: 'player_join' }, ({ payload }) => {
        setPlayers((prev) => {
          if (prev.some((p) => p.id === payload.id)) return prev;
          return [...prev, payload];
        });
      })
      .on('broadcast', { event: 'game_start' }, ({ payload }) => {
        startQuizGame(payload.questions, payload.source);
      })
      .on('broadcast', { event: 'player_answered' }, ({ payload }) => {
        setPlayers((prev) =>
          prev.map((p) => (p.id === payload.id ? { ...p, score: payload.score, answered: true } : p))
        );
      })
      .on('broadcast', { event: 'next_question' }, ({ payload }) => {
        setCurrentIndex(payload.nextIndex);
        setSelectedOption(null);
        setIsAnswered(false);
        setTimeLeft(15);
        setStage('playing');
        setPlayers((prev) => prev.map((p) => ({ ...p, answered: false })));
      })
      .on('broadcast', { event: 'game_finish' }, () => {
        setStage('final_result');
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          channel.send({
            type: 'broadcast',
            event: 'player_join',
            payload: {
              id: playerIdRef.current,
              name: initialUserName,
              score: 0,
              isHost: hostFlag,
              answered: false,
            },
          });
        }
      });

    channelRef.current = channel;
  };

  // 部屋作成（ホスト1人でも即座に一覧に登録）
  const handleCreateRoom = () => {
    const validName = userName.trim() || 'ホスト';
    const random4Digit = Math.floor(1000 + Math.random() * 9000).toString();
    setRoomCode(random4Digit);
    setIsHost(true);
    setStage('lobby');

    // 1人プレイ/ソロ確認でも動作するよう、自分自身を即座にplayersへ追加
    setPlayers([
      {
        id: playerIdRef.current,
        name: validName,
        score: 0,
        isHost: true,
        answered: false,
      },
    ]);

    connectToRoom(random4Digit, true, validName);
  };

  // 部屋参加（参加者自身も即座に一覧に登録）
  const handleJoinRoom = () => {
    const validName = userName.trim() || 'ゲスト';
    if (!/^\d{4}$/.test(inputCode)) return alert('4桁の半角数字を入力してください');
    setRoomCode(inputCode);
    setIsHost(false);
    setStage('lobby');

    setPlayers([
      {
        id: playerIdRef.current,
        name: validName,
        score: 0,
        isHost: false,
        answered: false,
      },
    ]);

    connectToRoom(inputCode, false, validName);
  };

  // 対戦開始ボタン
  const handleHostStartGame = async () => {
    setIsGenerating(true);

    try {
      const res = await fetch('/api/quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: questionCount, category: selectedCategory }),
      });
      const data = await res.json();

      if (!res.ok || !data.questions || data.questions.length === 0) {
        alert(data.error || '問題の取得に失敗しました');
        setIsGenerating(false);
        return;
      }

      // 他のプレイヤーへ配信
      broadcastMessage('game_start', {
        questions: data.questions,
        source: data.source,
      });

      // ホスト自身も直ちにクイズ画面へ遷移
      startQuizGame(data.questions, data.source);

    } catch (e: any) {
      alert(`通信エラーが発生しました: ${e.message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  // 制限時間カウントダウン
  useEffect(() => {
    if (stage !== 'playing' || isAnswered) return;

    timerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timerRef.current);
          handleAnswer(-1);
          return 0;
        }
        if (prev <= 4) playTone('tick');
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timerRef.current);
  }, [stage, isAnswered, currentIndex]);

  // 回答処理
  const handleAnswer = (idx: number) => {
    if (isAnswered) return;
    clearInterval(timerRef.current);
    setSelectedOption(idx);
    setIsAnswered(true);

    const currentQ = questions[currentIndex];
    const isCorrect = currentQ && idx === currentQ.answerIndex;
    let gainedPoints = 0;

    if (isCorrect) {
      playTone('correct');
      const timeBonus = timeLeft * 10;
      const comboBonus = combo * 20;
      gainedPoints = 100 + timeBonus + comboBonus;
      setCombo((prev) => prev + 1);
    } else {
      playTone('wrong');
      setCombo(0);
    }

    // 自身のスコアを更新
    setPlayers((prev) =>
      prev.map((p) =>
        p.id === playerIdRef.current
          ? { ...p, score: p.score + gainedPoints, answered: true }
          : p
      )
    );

    const myCurrent = players.find((p) => p.id === playerIdRef.current);
    const newScore = (myCurrent ? myCurrent.score : 0) + gainedPoints;

    broadcastMessage('player_answered', {
      id: playerIdRef.current,
      score: newScore,
    });
  };

  // 次の問題へ
  const handleHostNext = () => {
    if (currentIndex + 1 < questions.length) {
      const nextIdx = currentIndex + 1;
      broadcastMessage('next_question', { nextIndex: nextIdx });
      setCurrentIndex(nextIdx);
      setSelectedOption(null);
      setIsAnswered(false);
      setTimeLeft(15);
      setPlayers((prev) => prev.map((p) => ({ ...p, answered: false })));
    } else {
      broadcastMessage('game_finish', {});
      setStage('final_result');
    }
  };

  const rankedPlayers = useMemo(() => {
    return [...players].sort((a, b) => b.score - a.score);
  }, [players]);

  const currentQ = questions[currentIndex];
  const shareUrl = typeof window !== 'undefined' ? `${window.location.origin}/?room=${roomCode}` : '';

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-3 sm:p-6 font-sans">
      <div className="w-full max-w-md bg-white rounded-3xl shadow-xl border border-slate-200 overflow-hidden flex flex-col min-h-[640px] relative">
        {/* ヘッダー */}
        <div className="px-5 py-3.5 bg-white border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
            <span className="font-black text-slate-800 text-sm tracking-wide">Q-Battle Online</span>
          </div>
          {roomCode && (
            <div className="text-xs bg-indigo-50 border border-indigo-200 text-indigo-700 font-bold px-2.5 py-1 rounded-full">
              部屋: <span className="tracking-widest">{roomCode}</span>
            </div>
          )}
        </div>

        {/* 1. ホーム */}
        {stage === 'home' && (
          <div className="flex-1 p-6 flex flex-col justify-between">
            <div className="space-y-5 pt-2">
              <div className="text-center">
                <span className="text-xs font-bold text-indigo-600 bg-indigo-50 px-3 py-1 rounded-full border border-indigo-100">
                  リアルタイム対戦
                </span>
                <h1 className="text-2xl font-black text-slate-800 mt-2">クイズバトル！</h1>
                <p className="text-xs text-slate-500 mt-1">4桁コードやQRコードで友達と即対決</p>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-500 block mb-1.5">あなたのニックネーム</label>
                <input
                  type="text"
                  maxLength={10}
                  placeholder="名前を入力"
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-2.5">
                <label className="text-xs font-bold text-slate-500 block">友達の部屋に入る</label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    pattern="\d*"
                    maxLength={4}
                    placeholder="4桁の数字"
                    value={inputCode}
                    onChange={(e) => setInputCode(e.target.value)}
                    className="w-full px-4 py-2.5 bg-white border border-slate-200 rounded-xl text-center text-lg font-black tracking-widest text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                  <button
                    onClick={handleJoinRoom}
                    className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl whitespace-nowrap shadow-sm"
                  >
                    参加
                  </button>
                </div>
              </div>
            </div>

            <button
              onClick={handleCreateRoom}
              className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 active:scale-[0.98] text-white font-bold text-sm rounded-2xl shadow-lg shadow-indigo-100 transition-all flex items-center justify-center gap-2"
            >
              <span>部屋を作成する（ホスト）</span>
              <span>＋</span>
            </button>
          </div>
        )}

        {/* 2. ロビー */}
        {stage === 'lobby' && (
          <div className="flex-1 p-6 flex flex-col justify-between overflow-y-auto">
            <div className="text-center space-y-4">
              <div>
                <span className="text-xs font-bold text-slate-400">参加コード</span>
                <div className="text-4xl font-black text-indigo-600 tracking-widest mt-0.5">{roomCode}</div>
              </div>

              <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-sm inline-block mx-auto">
                <QRCodeSVG value={shareUrl} size={130} level="M" />
                <p className="text-[10px] text-slate-400 font-bold mt-1.5">カメラで読み取って即参加</p>
              </div>

              {isHost && (
                <div className="bg-slate-50 p-3 rounded-2xl border border-slate-200 text-left space-y-2">
                  <div className="flex justify-between items-center text-xs font-bold text-slate-600">
                    <span>ジャンル</span>
                    <select
                      value={selectedCategory}
                      onChange={(e) => setSelectedCategory(e.target.value)}
                      className="text-xs bg-white border border-slate-200 rounded-lg px-2 py-1 font-semibold text-slate-700"
                    >
                      <option value="all">全教科MIX</option>
                      <option value="国語">国語</option>
                      <option value="算数・数学">算数・数学</option>
                      <option value="理科">理科</option>
                      <option value="社会">社会</option>
                      <option value="雑学">雑学</option>
                    </select>
                  </div>
                  <div className="flex justify-between items-center text-xs font-bold text-slate-600">
                    <span>出題数</span>
                    <div className="flex gap-1.5">
                      {[5, 10].map((cnt) => (
                        <button
                          key={cnt}
                          onClick={() => setQuestionCount(cnt)}
                          className={`px-2.5 py-0.5 rounded-lg border text-xs font-bold ${
                            questionCount === cnt
                              ? 'bg-indigo-600 text-white border-indigo-600'
                              : 'bg-white text-slate-600 border-slate-200'
                          }`}
                        >
                          {cnt}問
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <div className="text-left">
                <div className="text-xs font-bold text-slate-500 mb-2 flex justify-between">
                  <span>参加中のメンバー ({players.length}人)</span>
                </div>
                <div className="space-y-1.5 max-h-32 overflow-y-auto">
                  {players.map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center justify-between p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs"
                    >
                      <span className="font-bold text-slate-700">
                        {p.name} {p.id === playerIdRef.current && '(自分)'}
                      </span>
                      {p.isHost && (
                        <span className="px-2 py-0.5 bg-amber-100 text-amber-700 rounded-md font-bold text-[10px]">
                          HOST
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="pt-3">
              {isHost ? (
                <button
                  disabled={isGenerating}
                  onClick={handleHostStartGame}
                  className="w-full py-4 bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] text-white font-bold text-sm rounded-2xl shadow-lg shadow-emerald-100 transition-all disabled:opacity-50"
                >
                  {isGenerating ? '問題を取得・翻訳中…' : '全員揃ったので対戦開始！'}
                </button>
              ) : (
                <div className="p-3 text-center bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-500">
                  ホストが対戦を開始するのを待っています…
                </div>
              )}
            </div>
          </div>
        )}

        {/* 3. クイズ対決中 */}
        {stage === 'playing' && (
          currentQ ? (
            <div className="flex-1 flex flex-col justify-between p-5">
              <div>
                <div className="flex items-center justify-between text-xs font-bold text-slate-500 mb-2">
                  <span>
                    第 {currentIndex + 1} / {questions.length} 問
                  </span>
                  <span className="text-indigo-600 font-black text-sm">
                    {players.find((p) => p.id === playerIdRef.current)?.score || 0} pt
                  </span>
                </div>

                <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden mb-3">
                  <div
                    className={`h-full transition-all duration-1000 linear ${
                      timeLeft <= 3 ? 'bg-rose-500 animate-pulse' : 'bg-indigo-500'
                    }`}
                    style={{ width: `${(timeLeft / 15) * 100}%` }}
                  />
                </div>

                <div className="flex items-center justify-between mb-2.5">
                  <div className="flex items-center gap-1.5">
                    <span className="px-2 py-0.5 rounded-md bg-slate-100 border border-slate-200 text-[11px] font-bold text-slate-600">
                      {currentQ.category || 'クイズ'}
                    </span>
                    <span className="px-2 py-0.5 rounded-md bg-indigo-50 border border-indigo-100 text-[11px] font-bold text-indigo-600">
                      {currentQ.gradeLevel || '一般'}
                    </span>
                  </div>
                  <span className="text-xs font-black text-slate-500">{timeLeft}s</span>
                </div>

                <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 min-h-[90px] flex items-center shadow-inner">
                  <h2 className="text-sm sm:text-base font-bold text-slate-800 leading-relaxed whitespace-pre-line">
                    {currentQ.question}
                  </h2>
                </div>
              </div>

              <div className="space-y-2.5 my-2">
                {currentQ.options && currentQ.options.map((opt: string, idx: number) => {
                  let btnStyle = 'bg-white border-slate-200 text-slate-700 shadow-sm';
                  if (isAnswered) {
                    if (idx === currentQ.answerIndex) {
                      btnStyle = 'bg-emerald-500 border-emerald-600 text-white font-bold ring-2 ring-emerald-200';
                    } else if (selectedOption === idx) {
                      btnStyle = 'bg-rose-500 border-rose-600 text-white font-bold';
                    } else {
                      btnStyle = 'bg-slate-50 border-slate-200 text-slate-300 opacity-60';
                    }
                  }

                  return (
                    <button
                      key={idx}
                      disabled={isAnswered}
                      onClick={() => handleAnswer(idx)}
                      className={`w-full p-3.5 rounded-2xl border text-left text-xs sm:text-sm font-semibold transition-all flex items-center gap-3 ${btnStyle} active:scale-[0.98]`}
                    >
                      <span className="w-6 h-6 rounded-lg bg-slate-100 text-slate-500 flex items-center justify-center text-xs font-black">
                        {['A', 'B', 'C', 'D'][idx]}
                      </span>
                      <span className="flex-1">{opt}</span>
                    </button>
                  );
                })}
              </div>

              {isAnswered && (
                <div className="bg-slate-50 border border-slate-200 p-3.5 rounded-2xl">
                  <div className="text-xs font-bold mb-1 flex justify-between">
                    <span className={selectedOption === currentQ.answerIndex ? 'text-emerald-600' : 'text-rose-600'}>
                      {selectedOption === currentQ.answerIndex ? '⭕ 正解！' : '❌ 不正解…'}
                    </span>
                    <span className="text-[10px] text-slate-400">出題元: {questionSource}</span>
                  </div>
                  <p className="text-[11px] text-slate-600 mb-3">{currentQ.explanation}</p>

                  {isHost ? (
                    <button
                      onClick={handleHostNext}
                      className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 active:scale-[0.98] text-white rounded-xl text-xs font-bold transition-all"
                    >
                      {currentIndex + 1 < questions.length ? '全員を次の問題へ進める →' : '対戦結果を見る'}
                    </button>
                  ) : (
                    <p className="text-[11px] text-center text-slate-400 font-bold py-1">
                      ホストが次の問題に進めるのを待っています…
                    </p>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center p-6 text-center">
              <p className="text-sm font-bold text-slate-500">問題データを読み込み中...</p>
            </div>
          )
        )}

        {/* 4. 最終リザルト発表 */}
        {stage === 'final_result' && (
          <div className="flex-1 p-6 flex flex-col justify-between overflow-y-auto">
            <div className="text-center pt-2">
              <span className="text-3xl">🏆</span>
              <h2 className="text-xl font-black text-slate-800 mt-2">バトル終了！</h2>
              <p className="text-xs text-slate-500 mt-0.5">対戦結果ランキング</p>

              <div className="mt-5 space-y-2">
                {rankedPlayers.map((player, rank) => (
                  <div
                    key={player.id}
                    className={`flex items-center justify-between p-3.5 rounded-2xl border text-xs font-bold ${
                      rank === 0
                        ? 'bg-amber-50/80 border-amber-300 text-amber-900 shadow-sm'
                        : 'bg-white border-slate-200 text-slate-700'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-black ${
                          rank === 0 ? 'bg-amber-400 text-white' : 'bg-slate-100 text-slate-500'
                        }`}
                      >
                        {rank + 1}
                      </span>
                      <span>
                        {player.name} {player.id === playerIdRef.current && '(自分)'}
                      </span>
                    </div>
                    <div className="text-sm font-black text-indigo-600">
                      {player.score} <span className="text-[10px] text-slate-400">pt</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <button
              onClick={() => {
                setStage('home');
                setRoomCode('');
                setPlayers([]);
              }}
              className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-sm rounded-2xl shadow-lg shadow-indigo-100 transition-all mt-6"
            >
              トップに戻る
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

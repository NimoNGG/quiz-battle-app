'use client';

import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { QRCodeSVG } from 'qrcode.react';

type Question = {
  id: string;
  category: string;
  gradeLevel: string;
  question: string;
  options: string[];
  answerIndex: number;
  explanation: string;
};

type Player = {
  id: string;
  name: string;
  score: number;
  isHost: boolean;
  hasAnswered?: boolean;
};

export default function QuizApp() {
  // ユーザー・ロビー状態
  const [playerName, setPlayerName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [isHost, setIsHost] = useState(false);
  const [myId] = useState(() => Math.random().toString(36).substring(2, 9));
  const [gameState, setGameState] = useState<'home' | 'lobby' | 'loading' | 'playing' | 'result'>('home');
  const [selectedCategory, setSelectedCategory] = useState('all');

  // プレイヤー一覧
  const [players, setPlayers] = useState<Player[]>([]);

  // クイズ状態
  const [questions, setQuestions] = useState<Question[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [isAnswered, setIsAnswered] = useState(false);
  const [myScore, setMyScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState(15);

  const channelRef = useRef<any>(null);

  // URLパラメータから部屋コードを取得
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const room = params.get('room');
      if (room) {
        setRoomCode(room.toUpperCase());
      }
    }
  }, []);

  // タイマー処理
  useEffect(() => {
    if (gameState !== 'playing' || isAnswered) return;

    if (timeLeft <= 0) {
      handleTimeUp();
      return;
    }

    const timer = setInterval(() => {
      setTimeLeft(prev => prev - 1);
    }, 1000);

    return () => clearInterval(timer);
  }, [gameState, timeLeft, isAnswered]);

  // Realtimeチャンネルの接続と監視
  const joinRoomChannel = (code: string, asHost: boolean) => {
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
    }

    const channel = supabase.channel(`room_${code}`, {
      config: {
        presence: {
          key: myId,
        },
      },
    });

    // 1. Presence 同期（参加者一覧の同期）
    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      const currentPlayers: Player[] = [];
      Object.keys(state).forEach(key => {
        const presenceList = state[key] as any[];
        if (presenceList && presenceList.length > 0) {
          const user = presenceList[0];
          currentPlayers.push({
            id: user.id,
            name: user.name,
            score: user.score || 0,
            isHost: user.isHost,
            hasAnswered: user.hasAnswered || false,
          });
        }
      });
      setPlayers(currentPlayers);
    });

    // 2. Broadcast イベントの受信
    channel
      // ゲーム開始
      .on('broadcast', { event: 'start_game' }, ({ payload }) => {
        setQuestions(payload.questions);
        setCurrentIndex(0);
        setSelectedAnswer(null);
        setIsAnswered(false);
        setMyScore(0);
        setTimeLeft(15);
        setGameState('playing');

        // presence のスコアリセット
        channel.track({
          id: myId,
          name: playerName,
          score: 0,
          isHost: asHost,
          hasAnswered: false,
        });
      })
      // 次の問題へ
      .on('broadcast', { event: 'next_question' }, ({ payload }) => {
        setCurrentIndex(payload.nextIndex);
        setSelectedAnswer(null);
        setIsAnswered(false);
        setTimeLeft(15);

        // presenceの回答状況を更新
        channel.track({
          id: myId,
          name: playerName,
          score: myScore,
          isHost: asHost,
          hasAnswered: false,
        });
      })
      // スコアの同期
      .on('broadcast', { event: 'update_score' }, ({ payload }) => {
        setPlayers(prev =>
          prev.map(p => (p.id === payload.id ? { ...p, score: payload.score, hasAnswered: true } : p))
        );
      })
      // 同じ部屋で再戦（リセット）
      .on('broadcast', { event: 'rematch' }, () => {
        setCurrentIndex(0);
        setSelectedAnswer(null);
        setIsAnswered(false);
        setMyScore(0);
        setTimeLeft(15);
        setGameState('lobby');

        channel.track({
          id: myId,
          name: playerName,
          score: 0,
          isHost: asHost,
          hasAnswered: false,
        });
      });

    // 接続完了後に Presence を送信
    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({
          id: myId,
          name: playerName,
          score: 0,
          isHost: asHost,
          hasAnswered: false,
        });
      }
    });

    channelRef.current = channel;
  };

  // 部屋作成（ホスト）
  const handleCreateRoom = () => {
    if (!playerName.trim()) return alert('名前を入力してください！');
    const randomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
    setRoomCode(randomCode);
    setIsHost(true);
    joinRoomChannel(randomCode, true);
    setGameState('lobby');
  };

  // 部屋参加（ゲスト）
  const handleJoinRoom = () => {
    if (!playerName.trim()) return alert('名前を入力してください！');
    if (!roomCode.trim()) return alert('4桁の部屋コードを入力してください！');
    const upperCode = roomCode.trim().toUpperCase();
    setRoomCode(upperCode);
    setIsHost(false);
    joinRoomChannel(upperCode, false);
    setGameState('lobby');
  };

  // 対戦開始（ホストが実行）
  const handleStartGame = async () => {
    setGameState('loading');

    try {
      const res = await fetch('/api/quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 5, category: selectedCategory }),
      });
      const data = await res.json();

      if (data.questions && data.questions.length > 0) {
        // 全員へ一斉に開始イベントを通知
        channelRef.current.send({
          type: 'broadcast',
          event: 'start_game',
          payload: { questions: data.questions },
        });

        setQuestions(data.questions);
        setCurrentIndex(0);
        setSelectedAnswer(null);
        setIsAnswered(false);
        setMyScore(0);
        setTimeLeft(15);
        setGameState('playing');
      } else {
        alert('問題の取得に失敗しました。');
        setGameState('lobby');
      }
    } catch (e) {
      alert('通信エラーが発生しました。');
      setGameState('lobby');
    }
  };

  // 回答処理
  const handleSelectOption = (index: number) => {
    if (isAnswered) return;

    setSelectedAnswer(index);
    setIsAnswered(true);

    const isCorrect = index === questions[currentIndex].answerIndex;
    const newScore = isCorrect ? myScore + Math.max(10, timeLeft * 10) : myScore;
    if (isCorrect) setMyScore(newScore);

    // 自分のスコアと回答完了状態を全員へ送信
    channelRef.current.send({
      type: 'broadcast',
      event: 'update_score',
      payload: { id: myId, score: newScore },
    });

    channelRef.current.track({
      id: myId,
      name: playerName,
      score: newScore,
      isHost: isHost,
      hasAnswered: true,
    });
  };

  // 時間切れ
  const handleTimeUp = () => {
    setIsAnswered(true);
    channelRef.current.track({
      id: myId,
      name: playerName,
      score: myScore,
      isHost: isHost,
      hasAnswered: true,
    });
  };

  // 次の問題へ（ホストが進行）
  const handleNextQuestion = () => {
    if (currentIndex + 1 < questions.length) {
      const next = currentIndex + 1;
      channelRef.current.send({
        type: 'broadcast',
        event: 'next_question',
        payload: { nextIndex: next },
      });
      setCurrentIndex(next);
      setSelectedAnswer(null);
      setIsAnswered(false);
      setTimeLeft(15);
    } else {
      // 最終結果へ
      setGameState('result');
    }
  };

  // 同じ部屋でもう一度遊ぶ（部屋維持）
  const handleRematch = () => {
    if (!isHost) return;
    channelRef.current.send({
      type: 'broadcast',
      event: 'rematch',
      payload: {},
    });
    setGameState('lobby');
  };

  // 招待URL
  const shareUrl = typeof window !== 'undefined' ? `${window.location.origin}?room=${roomCode}` : '';

  return (
    <div className="min-h-screen bg-slate-900 text-white flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md bg-slate-800 rounded-3xl p-6 shadow-2xl border border-slate-700">

        {/* 1. ホーム画面 */}
        {gameState === 'home' && (
          <div className="flex flex-col gap-6">
            <div className="text-center">
              <h1 className="text-3xl font-black bg-gradient-to-r from-amber-400 to-orange-500 bg-clip-text text-transparent">
                義務教育クイズ対戦
              </h1>
              <p className="text-xs text-slate-400 mt-1">小中学校の教科書・雑学でリアルタイム対決！</p>
            </div>

            <div className="flex flex-col gap-3">
              <label className="text-xs font-bold text-slate-400">あなたのプレイヤー名</label>
              <input
                type="text"
                placeholder="ニックネームを入力"
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                className="bg-slate-700 border border-slate-600 rounded-xl px-4 py-3 text-white font-bold outline-none focus:border-amber-400"
              />
            </div>

            <div className="flex flex-col gap-3">
              <button
                onClick={handleCreateRoom}
                className="w-full bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-slate-950 font-black py-4 rounded-xl shadow-lg transition active:scale-95"
              >
                部屋を作ってホストになる
              </button>

              <div className="flex items-center gap-2 my-1">
                <div className="flex-1 h-px bg-slate-700"></div>
                <span className="text-xs text-slate-500 font-bold">または</span>
                <div className="flex-1 h-px bg-slate-700"></div>
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="部屋番号(4桁)"
                  maxLength={4}
                  value={roomCode}
                  onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                  className="w-1/2 bg-slate-700 border border-slate-600 rounded-xl px-4 py-3 text-center uppercase font-black text-amber-400 tracking-widest outline-none focus:border-amber-400"
                />
                <button
                  onClick={handleJoinRoom}
                  className="flex-1 bg-slate-700 hover:bg-slate-600 text-white font-bold py-3 rounded-xl border border-slate-600 transition active:scale-95"
                >
                  部屋に入る
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 2. ロビー画面 */}
        {gameState === 'lobby' && (
          <div className="flex flex-col gap-5">
            <div className="flex justify-between items-center bg-slate-700/50 p-4 rounded-2xl border border-slate-600">
              <div>
                <span className="text-xs font-bold text-slate-400 block">部屋コード</span>
                <span className="text-2xl font-black text-amber-400 tracking-wider">{roomCode}</span>
              </div>
              <div className="bg-white p-2 rounded-xl">
                <QRCodeSVG value={shareUrl} size={64} />
              </div>
            </div>

            {/* ジャンル選択（ホストのみ選択可） */}
            {isHost && (
              <div className="flex flex-col gap-2 bg-slate-700/30 p-3 rounded-xl border border-slate-700">
                <label className="text-xs font-bold text-slate-400">出題ジャンル</label>
                <select
                  value={selectedCategory}
                  onChange={(e) => setSelectedCategory(e.target.value)}
                  className="bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm font-bold text-white outline-none focus:border-amber-400"
                >
                  <option value="all">全教科MIX</option>
                  <option value="国語">国語</option>
                  <option value="算数・数学">算数・数学</option>
                  <option value="理科">理科</option>
                  <option value="社会">社会</option>
                  <option value="雑学">雑学</option>
                </select>
              </div>
            )}

            {/* 参加メンバー一覧（ホスト・参加者両方に全員映る） */}
            <div className="flex flex-col gap-2">
              <span className="text-xs font-bold text-slate-400">参加メンバー ({players.length}人)</span>
              <div className="flex flex-col gap-2 max-h-48 overflow-y-auto">
                {players.map((p) => (
                  <div
                    key={p.id}
                    className={`flex justify-between items-center px-4 py-3 rounded-xl border ${
                      p.id === myId
                        ? 'bg-amber-500/10 border-amber-500/40'
                        : 'bg-slate-700 border-slate-600'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-bold">{p.name}</span>
                      {p.id === myId && <span className="text-xs bg-amber-500 text-slate-950 font-black px-1.5 py-0.5 rounded">自分</span>}
                    </div>
                    {p.isHost && <span className="text-xs bg-slate-600 text-slate-300 font-bold px-2 py-0.5 rounded">ホスト</span>}
                  </div>
                ))}
              </div>
            </div>

            {/* スタートボタン / 待機表示 */}
            {isHost ? (
              <button
                onClick={handleStartGame}
                className="w-full bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-slate-950 font-black py-4 rounded-xl shadow-lg transition active:scale-95"
              >
                全員揃った！対戦開始
              </button>
            ) : (
              <div className="text-center py-4 bg-slate-700/30 rounded-xl border border-slate-700 text-sm font-bold text-slate-400 animate-pulse">
                ホストがゲームを開始するのを待っています...
              </div>
            )}
          </div>
        )}

        {/* 3. 問題取得中画面（ご要望の「ちょっと待ってね！」演出） */}
        {gameState === 'loading' && (
          <div className="flex flex-col items-center justify-center py-12 gap-4">
            <div className="w-12 h-12 border-4 border-amber-400 border-t-transparent rounded-full animate-spin"></div>
            <div className="text-center">
              <h2 className="text-lg font-black text-amber-400">問題取得中…</h2>
              <p className="text-xs text-slate-400 mt-1 font-bold">ちょっと待ってね！まもなく始まります！</p>
            </div>
          </div>
        )}

        {/* 4. クイズ出題・対戦画面 */}
        {gameState === 'playing' && questions[currentIndex] && (
          <div className="flex flex-col gap-4">
            {/* 上部ステータス */}
            <div className="flex justify-between items-center text-xs font-bold text-slate-400 border-b border-slate-700 pb-3">
              <span className="bg-slate-700 px-2 py-1 rounded text-amber-400">
                第 {currentIndex + 1} / {questions.length} 問
              </span>
              <span className="text-slate-400 font-bold">
                {questions[currentIndex].category}
              </span>
              <span className={`text-base font-black ${timeLeft <= 5 ? 'text-red-500 animate-pulse' : 'text-white'}`}>
                ⏱ {timeLeft}秒
              </span>
            </div>

            {/* リアルタイム対戦状況バー（全員の状況が見える） */}
            <div className="grid grid-cols-2 gap-2 bg-slate-700/40 p-2.5 rounded-xl border border-slate-700">
              {players.map(p => (
                <div key={p.id} className="flex justify-between items-center text-xs px-2 py-1 bg-slate-800 rounded-lg">
                  <span className="truncate max-w-[80px] font-bold">
                    {p.name} {p.id === myId ? '(自分)' : ''}
                  </span>
                  <span className="font-mono text-amber-400 font-bold">{p.score}pt</span>
                </div>
              ))}
            </div>

            {/* 問題文 */}
            <div className="py-2">
              <p className="text-base font-bold leading-relaxed">
                {questions[currentIndex].question}
              </p>
            </div>

            {/* 選択肢ボタン */}
            <div className="flex flex-col gap-2">
              {questions[currentIndex].options.map((opt, idx) => {
                let btnStyle = 'bg-slate-700 hover:bg-slate-600 border-slate-600 text-white';

                if (isAnswered) {
                  if (idx === questions[currentIndex].answerIndex) {
                    btnStyle = 'bg-emerald-600 border-emerald-500 text-white'; // 正解
                  } else if (idx === selectedAnswer) {
                    btnStyle = 'bg-rose-600 border-rose-500 text-white'; // 不正解
                  } else {
                    btnStyle = 'bg-slate-800 border-slate-700 opacity-40 text-slate-400';
                  }
                }

                return (
                  <button
                    key={idx}
                    disabled={isAnswered}
                    onClick={() => handleSelectOption(idx)}
                    className={`w-full text-left font-bold px-4 py-3 rounded-xl border transition ${btnStyle}`}
                  >
                    <span className="mr-2 opacity-60 font-mono">{idx + 1}.</span>
                    {opt}
                  </button>
                );
              })}
            </div>

            {/* 回答後の解説 ＆ ホストによる進行ボタン */}
            {isAnswered && (
              <div className="flex flex-col gap-3 mt-2 bg-slate-700/50 p-3 rounded-xl border border-slate-600">
                <p className="text-xs text-slate-300">
                  <strong className="text-amber-400">解説: </strong>
                  {questions[currentIndex].explanation}
                </p>

                {isHost ? (
                  <button
                    onClick={handleNextQuestion}
                    className="w-full bg-amber-500 hover:bg-amber-600 text-slate-950 font-black py-3 rounded-lg transition active:scale-95"
                  >
                    {currentIndex + 1 < questions.length ? '次の問題へ' : '結果発表を見る'}
                  </button>
                ) : (
                  <div className="text-center text-xs font-bold text-slate-400 py-1">
                    ホストが次の問題に進めるのを待っています...
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* 5. 最終結果画面（全員の結果を表示 ＆ 部屋維持再戦） */}
        {gameState === 'result' && (
          <div className="flex flex-col gap-6 text-center">
            <div>
              <h2 className="text-2xl font-black bg-gradient-to-r from-amber-400 to-orange-500 bg-clip-text text-transparent">
                対戦結果発表！
              </h2>
              <p className="text-xs text-slate-400 mt-1">部屋コード: {roomCode}</p>
            </div>

            {/* 全員のランキング・スコア結果 */}
            <div className="flex flex-col gap-2">
              {[...players]
                .sort((a, b) => b.score - a.score)
                .map((p, idx) => (
                  <div
                    key={p.id}
                    className={`flex justify-between items-center p-3 rounded-xl border ${
                      idx === 0
                        ? 'bg-amber-500/20 border-amber-500/60 font-black'
                        : 'bg-slate-700 border-slate-600'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span className={`w-6 h-6 flex items-center justify-center rounded-full text-xs font-black ${
                        idx === 0 ? 'bg-amber-400 text-slate-950' : 'bg-slate-600 text-slate-300'
                      }`}>
                        {idx + 1}
                      </span>
                      <span className="font-bold">
                        {p.name} {p.id === myId ? '(自分)' : ''}
                      </span>
                    </div>
                    <span className="font-mono text-base font-black text-amber-400">{p.score} pt</span>
                  </div>
                ))}
            </div>

            {/* 部屋を維持してもう一度遊ぶボタン */}
            <div className="flex flex-col gap-2">
              {isHost ? (
                <button
                  onClick={handleRematch}
                  className="w-full bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-slate-950 font-black py-4 rounded-xl shadow-lg transition active:scale-95"
                >
                  同じ部屋でもう一度遊ぶ
                </button>
              ) : (
                <div className="text-sm font-bold text-slate-400 bg-slate-700/40 py-3 rounded-xl border border-slate-700 animate-pulse">
                  ホストが再戦の準備をするのを待っています...
                </div>
              )}

              <button
                onClick={() => {
                  if (channelRef.current) supabase.removeChannel(channelRef.current);
                  setGameState('home');
                }}
                className="w-full bg-slate-700 hover:bg-slate-600 text-white font-bold py-3 rounded-xl border border-slate-600 transition"
              >
                部屋を退出する
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

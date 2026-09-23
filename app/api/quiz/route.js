import { NextResponse, after } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { supabase } from '@/lib/supabase';

// 初期フォールバック（万が一DBが空の初回用）
const SEED_QUESTIONS = [
  {
    category: "国語",
    grade_level: "小学校",
    question: "「矛盾」の語源となった故事で、商人が売っていた武器の組み合わせは？",
    options: ["矛と盾", "剣と鎧", "弓と矢", "槍と兜"],
    answer_index: 0,
    explanation: "何でも突き通す矛と、何でも防ぐ盾の話です。"
  },
  {
    category: "算数・数学",
    grade_level: "中学校",
    question: "直角三角形の直角を挟む2辺の長さをa, b、斜辺をcとするとき成り立つ「三平方の定理」は？",
    options: ["a² + b² = c²", "a + b = c", "ab = c²", "a² - b² = c²"],
    answer_index: 0,
    explanation: "ピタゴラスの定理（a² + b² = c²）です。"
  },
  {
    category: "理科",
    grade_level: "小学校",
    question: "光合成を行う際に植物が吸収する気体と、排出する気体の正しい組み合わせは？",
    options: ["吸収:二酸化炭素 / 排出:酸素", "吸収:酸素 / 排出:二酸化炭素", "吸収:窒素 / 排出:酸素", "吸収:水素 / 排出:二酸化炭素"],
    answer_index: 0,
    explanation: "光合成では二酸化炭素を取り込み酸素を出します。"
  },
  {
    category: "社会",
    grade_level: "中学校",
    question: "1603年に江戸幕府を開き、初代征夷大将軍となった人物は？",
    options: ["徳川家康", "織田信長", "豊臣秀吉", "徳川家光"],
    answer_index: 0,
    explanation: "関ヶ原の戦いを経て徳川家康が開きました。"
  },
  {
    category: "雑学",
    grade_level: "一般",
    question: "日本の紙幣（お札）を発行している唯一の機関は？",
    options: ["日本銀行", "財務省", "造幣局", "国立印刷局"],
    answer_index: 0,
    explanation: "お札は日本銀行、硬貨は政府（造幣局）です。"
  }
];

// 混雑時に順次試行するモデル
const MODELS_TO_TRY = ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.7-flash'];

// バックグラウンドで静かに問題を生成してSupabaseに補充する関数（プレイヤーの通信は一切待たせない）
async function replenishQuestionsInBackground(category) {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) return;

  try {
    const ai = new GoogleGenAI({ apiKey });
    const targetCat = category === 'all' ? '国語, 算数・数学, 理科, 社会, 雑学' : category;

    const prompt = `日本の小学校・中学校の教科書内容、または日本で親しまれる良質な雑学から、4択クイズを5問作成してください。
ジャンル: ${targetCat}
条件:
- 日本の学習指導要領や学校の授業で習う親しみやすい良問
- 選択肢は4つ（正解1、誤答3）
- マークダウン記法（\`\`\`json等）は含めず、純粋なJSON配列のみを出力

出力フォーマット:
[
  {
    "category": "${category === 'all' ? '教科名' : category}",
    "grade_level": "小学校/中学校/一般",
    "question": "問題文",
    "options": ["正解", "誤答1", "誤答2", "誤答3"],
    "answer_index": 0,
    "explanation": "25文字以内の簡潔な解説"
  }
]`;

    let parsed = null;

    for (const modelName of MODELS_TO_TRY) {
      try {
        const res = await ai.models.generateContent({
          model: modelName,
          contents: prompt,
          config: { responseMimeType: 'application/json' }
        });
        parsed = JSON.parse(res.text.trim());
        if (Array.isArray(parsed) && parsed.length > 0) {
          break;
        }
      } catch (e) {
        // 503などの高負荷時は次モデルへフォールバック
        continue;
      }
    }

    if (Array.isArray(parsed) && parsed.length > 0) {
      // 選択肢のシャッフルと正解インデックスの再計算
      const rows = parsed.map(q => {
        const correctText = q.options[q.answer_index || 0];
        const shuffled = [...q.options].sort(() => 0.5 - Math.random());
        return {
          category: q.category || '雑学',
          grade_level: q.grade_level || '一般',
          question: q.question,
          options: shuffled,
          answer_index: shuffled.indexOf(correctText),
          explanation: q.explanation || `正解は「${correctText}」です。`
        };
      });

      // 重複問題は自動無視
      const { error } = await supabase
        .from('quiz_questions')
        .upsert(rows, { onConflict: 'question', ignoreDuplicates: true });

      if (!error) {
        console.log(`[自動増殖成功] 新たに ${rows.length} 問をSupabaseにストックしました！`);
      }
    }
  } catch (err) {
    console.warn('[自動増殖スキップ]:', err.message);
  }
}

export async function POST(req) {
  try {
    const { count = 5, category = 'all' } = await req.json();

    // 1. Supabaseからストックを取得（約0.05秒で超高速返却）
    let query = supabase.from('quiz_questions').select('*');
    if (category !== 'all') {
      query = query.eq('category', category);
    }

    let { data: stock, error } = await query;

    // 初回などで万が一DBが空の場合はシードデータを一時利用＆保存
    if (!error && (!stock || stock.length === 0)) {
      await supabase.from('quiz_questions').upsert(SEED_QUESTIONS, { onConflict: 'question', ignoreDuplicates: true });
      stock = SEED_QUESTIONS;
    }

    const currentPool = (stock && stock.length > 0) ? stock : SEED_QUESTIONS;
    const shuffled = [...currentPool].sort(() => 0.5 - Math.random()).slice(0, count);

    // ★ 2. after() を使用
    // レスポンス返却後も Vercel 等のサーバーレス基盤上で処理が途中で破棄されず、裏で安全にDBへ補充を完了させる
    after(async () => {
      await replenishQuestionsInBackground(category);
    });

    // 3. プレイヤーには待ち時間0で即座に出題データを返す
    return NextResponse.json({
      source: '公式ストックDB',
      questions: shuffled.map(q => ({
        id: q.id || `q-${Math.random()}`,
        category: q.category,
        gradeLevel: q.grade_level,
        question: q.question,
        options: q.options,
        answerIndex: q.answer_index,
        explanation: q.explanation
      }))
    });

  } catch (error) {
    console.error('Quiz Route Error:', error);
    return NextResponse.json({
      source: '初期ストック',
      questions: SEED_QUESTIONS.slice(0, 5).map(q => ({
        id: `seed-${Math.random()}`,
        category: q.category,
        gradeLevel: q.grade_level,
        question: q.question,
        options: q.options,
        answerIndex: q.answer_index,
        explanation: q.explanation
      }))
    });
  }
}

import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { supabase } from '@/lib/supabase';

// 裏側で静かに問題を生成してSupabaseに補充する関数（プレイヤーは待たせない）
async function replenishInBackground(category) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return;

  try {
    const ai = new GoogleGenAI({ apiKey });
    const targetCat = category === 'all' ? '国語, 算数・数学, 理科, 社会, 雑学' : category;

    const prompt = `日本の小学校・中学校の義務教育教科（または日本人向け雑学）から、面白い4択クイズを2問作成してください。
ジャンル: ${targetCat}
条件:
- 日本の教科書や一般常識に基づく良問
- 選択肢は4つ（正解1、誤答3）
- マークダウンは不要、純粋なJSON配列のみを出力

出力フォーマット:
[
  {
    "category": "${category === 'all' ? '教科名' : category}",
    "grade_level": "小中学校・一般",
    "question": "問題文",
    "options": ["正解", "誤答1", "誤答2", "誤答3"],
    "answer_index": 0,
    "explanation": "25文字以内の簡潔な解説"
  }
]`;

    const res = await ai.models.generateContent({
      model: 'gemini-3.5-flash-lite',
      contents: prompt,
      config: { responseMimeType: 'application/json' }
    });

    const parsed = JSON.parse(res.text.trim());
    if (Array.isArray(parsed) && parsed.length > 0) {
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

      await supabase
        .from('quiz_questions')
        .upsert(rows, { onConflict: 'question', ignoreDuplicates: true });

      console.log(`[自動増殖] 新たに ${rows.length} 問がSupabaseに補充されました`);
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

    const { data: stock, error } = await query;

    if (error || !stock || stock.length === 0) {
      return NextResponse.json({ error: '問題ストックがありません' }, { status: 500 });
    }

    // ランダムに指定問数をピックアップ
    const shuffled = [...stock].sort(() => 0.5 - Math.random()).slice(0, count);

    // ★ 2. プレイヤーを待たせずに裏側で補充タスクを蹴る（awaitしない）
    replenishInBackground(category).catch(() => {});

    // 3. クイズを即返却
    return NextResponse.json({
      source: '公式ストックDB',
      questions: shuffled.map(q => ({
        id: q.id,
        category: q.category,
        gradeLevel: q.grade_level,
        question: q.question,
        options: q.options,
        answerIndex: q.answer_index,
        explanation: q.explanation
      }))
    });

  } catch (error) {
    console.error('API Error:', error);
    return NextResponse.json({ error: '問題の取得に失敗しました' }, { status: 500 });
  }
}
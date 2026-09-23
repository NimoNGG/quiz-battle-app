// scripts/seed.js
const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
const supabaseKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim();
const geminiKey = (process.env.GEMINI_API_KEY || '').trim();

if (!supabaseUrl || !supabaseKey || !geminiKey) {
  console.error('環境変数が不足しています。.env.local を確認してください。');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const ai = new GoogleGenAI({ apiKey: geminiKey });

const CATEGORIES = ['国語', '算数・数学', '理科', '社会', '雑学'];
// 混雑時に順次フォールバックするモデル一覧
const MODELS_TO_TRY = ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.7-flash'];

async function seedCategory(cat) {
  console.log(`[生成中] ${cat} の義務教育クイズを取得中...`);
  const prompt = `日本の小学校・中学校の教科書内容、および日本で親しまれる良質な雑学から、4択クイズを8問作成してください。
ジャンル: ${cat}
条件:
- 日本の小中学生〜大人が楽しめる良問
- 選択肢は4つ（正解1、誤答3）
- マークダウン記法（\`\`\`json等）は含めず、純粋なJSON配列のみを出力

出力形式:
[
  {
    "category": "${cat}",
    "grade_level": "小中学校・一般",
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
        break; // 成功したらループを抜ける
      }
    } catch (e) {
      console.warn(`  └ モデル ${modelName} 混雑・エラー (${e.message || '503'})。別モデルで再試行...`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  if (!parsed) {
    console.error(`[スキップ] ${cat}: すべてのモデルが高負荷のため失敗しました`);
    return;
  }

  try {
    const rows = parsed.map(q => {
      const correct = q.options[q.answer_index || 0];
      const shuffled = [...q.options].sort(() => 0.5 - Math.random());
      return {
        category: q.category,
        grade_level: q.grade_level,
        question: q.question,
        options: shuffled,
        answer_index: shuffled.indexOf(correct),
        explanation: q.explanation || `正解は「${correct}」です。`
      };
    });

    const { error } = await supabase
      .from('quiz_questions')
      .upsert(rows, { onConflict: 'question', ignoreDuplicates: true });

    if (error) {
      console.error(`[エラー] ${cat}:`, error.message);
    } else {
      console.log(`[成功] ${cat}: ${rows.length}問をSupabaseにストック完了！`);
    }
  } catch (e) {
    console.error(`[DBエラー] ${cat}:`, e.message);
  }
}

async function main() {
  for (const cat of CATEGORIES) {
    await seedCategory(cat);
    await new Promise(r => setTimeout(r, 1500)); // レート制限対策のウェイト
  }
  console.log('\n全教科の処理が完了しました！');
}

main();
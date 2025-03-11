import dotenv from "dotenv";
dotenv.config();

import express from "express";
import session from "express-session";
import FileStoreFactory from "session-file-store";
import { OpenAI } from "openai";

const app = express();
app.use(express.json());
app.use(express.static("public"));

// Configuration de la session avec session-file-store
const FileStore = FileStoreFactory(session);
app.use(session({
  store: new FileStore({ path: './sessions' }),
  secret: 'votre_secret_ici', // Remplacez par une clé secrète robuste
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Passez à true si vous utilisez HTTPS en production
}));

// Définition du prompt système pour la conversation générale
const systemPrompt = `
  You are an English teacher dedicated to helping the user improve their written English. For every message:
  - First, check for any grammar, spelling, or punctuation errors.
  - If errors are found, provide the corrected sentence and a brief explanation of the correction.
  - Always respond in English.
  - Refuse to discuss topics unrelated to improving English writing.
  - Allowed topics are: travel, food, music, technology, sports, society, health, nature.
  - Keep your replies short (1 to 3 sentences).
  - If I write in another language, gently remind me to use English only.
  - When replying, always finish your reply asking something in relation with the subject.
  - Use vocabulary and style suitable for the user's selected difficulty level: beginner, intermediate, or expert.
`;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Récupère ou initialise l'historique de conversation dans la session
 */
function getConversationHistory(req) {
  if (!req.session.conversationHistory) {
    req.session.conversationHistory = [{ role: "system", content: systemPrompt }];
    console.log("Initialisation de l'historique de conversation pour la session.");
  }
  return req.session.conversationHistory;
}

/**
 * Tronque l'historique pour ne conserver que le message système + 8 messages
 */
function trimHistory(history) {
  if (history.length > 1 + 8) {
    return [history[0]].concat(history.slice(-8));
  }
  return history;
}

/**
 * Endpoint pour la conversation textuelle (chat).
 */
app.post("/api/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;
    console.log("Requête /api/chat reçue. Message utilisateur:", userMessage);

    let conversationHistory = getConversationHistory(req);
    conversationHistory.push({ role: "user", content: userMessage });
    console.log("Historique (après ajout userMessage):", conversationHistory);

    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: conversationHistory,
      max_tokens: 150
    });
    const assistantMessage = response.choices[0].message.content;
    console.log("Réponse d'OpenAI:", assistantMessage);

    conversationHistory.push({ role: "assistant", content: assistantMessage });
    req.session.conversationHistory = trimHistory(conversationHistory);

    res.json({ response: assistantMessage });
  } catch (error) {
    console.error("Erreur /api/chat:", error);
    res.status(500).json({ error: "Erreur du serveur lors du chat" });
  }
});

/**
 * Endpoint pour générer un test écrit aléatoire selon un niveau (A1 à C2).
 * Stocke le test dans req.session.currentTest pour être corrigé plus tard.
 */
app.post("/api/generate-test", async (req, res) => {
  try {
    const { level } = req.body;
    if (!level) {
      return res.status(400).json({ error: "Le niveau est requis" });
    }
    console.log("Requête /api/generate-test pour le niveau:", level);

    // Prompt pour générer le test
    const prompt = `Generate a written English test for a ${level} level learner. The test should consist of 8 questions. For each question, provide a clear question text. Some questions should be multiple choice with 4 options, and others should be open-ended. Return only a valid JSON object (with no extra text) in the following format:
{
  "questions": [
    {
      "text": "Question text",
      "type": "multiple" or "open",
      "options": ["option1", "option2", "option3", "option4"],
      "answer": "correct answer"
    },
    ...
  ]
}`;

    console.log("Prompt pour générer le test:", prompt);

    const messages = [
      { role: "system", content: "You are an English test generator." },
      { role: "user", content: prompt }
    ];

    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages,
      max_tokens: 500
    });

    const testOutput = response.choices[0].message.content;
    console.log("Test généré (raw):", testOutput);

    let parsedTest;
    try {
      parsedTest = JSON.parse(testOutput);
    } catch (e) {
      console.error("Erreur de parsing JSON du test:", e);
      return res.json({ error: "No test generated." });
    }

    if (!parsedTest || !parsedTest.questions || parsedTest.questions.length === 0) {
      console.error("Aucun test généré après parsing.");
      return res.json({ error: "No test generated." });
    }

    // Stocke le test dans la session pour pouvoir le corriger plus tard
    req.session.currentTest = parsedTest;

    // Renvoie le test au frontend
    res.json(parsedTest);
  } catch (error) {
    console.error("Erreur /api/generate-test:", error);
    res.status(500).json({ error: "Erreur lors de la génération du test" });
  }
});

/**
 * Endpoint pour soumettre et corriger le test.
 */
app.post("/api/submit-test", async (req, res) => {
  try {
    const { answers } = req.body;
    if (!answers || !Array.isArray(answers)) {
      return res.status(400).json({ error: "No answers provided or invalid format." });
    }
    console.log("Requête /api/submit-test reçue. Answers:", answers);

    const currentTest = req.session.currentTest;
    if (!currentTest || !currentTest.questions) {
      return res.status(400).json({ error: "No test found in session." });
    }

    const corrections = [];
    answers.forEach(ans => {
      const questionIndex = parseInt(ans.questionIndex, 10);
      const userAnswer = ans.answer;
      const questionData = currentTest.questions[questionIndex];

      if (!questionData) {
        corrections.push({
          questionIndex,
          status: "error",
          message: "Question not found"
        });
        return;
      }

      // Compare la réponse user à la "bonne" réponse
      if (questionData.type === "multiple") {
        const isCorrect = (userAnswer.trim() === questionData.answer.trim());
        corrections.push({
          questionIndex,
          question: questionData.text,
          userAnswer,
          correctAnswer: questionData.answer,
          isCorrect
        });
      } else {
        // questionData.type === "open" 
        // Comparaison naïve, 
        // ou utilisation d'OpenAI pour analyser la réponse (non implémenté ici).
        const isCorrect = (userAnswer.trim().toLowerCase() === questionData.answer.trim().toLowerCase());
        corrections.push({
          questionIndex,
          question: questionData.text,
          userAnswer,
          correctAnswer: questionData.answer,
          isCorrect
        });
      }
    });

    // Construire un résumé HTML
    let correctionText = "";
    corrections.forEach(corr => {
      if (corr.status === "error") {
        correctionText += `Question ${corr.questionIndex + 1}: ${corr.message}<br>`;
      } else {
        correctionText += `Question ${corr.questionIndex + 1} (${corr.question}):<br>`;
        correctionText += `Your answer: ${corr.userAnswer}<br>`;
        if (corr.isCorrect) {
          correctionText += `<strong>Correct!</strong><br>`;
        } else {
          correctionText += `<strong>Wrong.</strong> Correct answer: ${corr.correctAnswer}<br>`;
        }
        correctionText += `<br>`;
      }
    });

    res.json({ correction: correctionText });
  } catch (error) {
    console.error("Erreur /api/submit-test:", error);
    res.status(500).json({ error: "Erreur lors de la correction du test" });
  }
});

// Écoute sur localhost pour éviter un accès direct via l'IP publique
app.listen(3000, "127.0.0.1", () => {
  console.log("Serveur démarré sur http://127.0.0.1:3000");
});


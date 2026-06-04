import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import OpenAI from 'openai';
import { 
  initializeData, 
  setConnectionMode, 
  getKPIs, 
  getAnalytics, 
  queryReservations, 
  createReservation, 
  updateReservation, 
  deleteReservation 
} from './data_loader.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/hotel_reservations';

// Express Middleware
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://front-pi-eosin.vercel.app',
  process.env.CLIENT_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (e.g. curl, Postman, same-origin)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json());

// Heuristic cancellation prediction logic derived from CSV stats
function predictCancellation(data) {
  const leadTime = parseInt(data.leadTime, 10) || 0;
  const roomCategory = data.roomCategory || 'Standard';
  const segment = data.segment || 'WalkIn';
  const price = parseFloat(data.price) || 0.0;
  const adults = parseInt(data.adults, 10) || 2;
  const children = parseInt(data.children, 10) || 0;

  let prob = 25.0; // Base probability

  // 1. Room Category adjustments
  if (roomCategory === 'Standard') prob += 1.5;
  else if (roomCategory === 'Family') prob -= 4.0;
  else if (roomCategory === 'Suite') prob -= 18.0;
  else if (roomCategory === 'Autre') prob -= 18.0;

  // 2. Segment adjustments
  if (segment === 'WEB') prob += 30.0;
  else if (segment === 'Other') prob += 26.0;
  else if (segment === 'VCR') prob += 24.0;
  else if (segment === 'CRS') prob += 20.0;
  else if (segment === 'AVM') prob += 15.0;
  else if (segment === 'DIRECT') prob += 0.5;
  else if (segment === 'WalkIn') prob -= 0.3;
  else if (segment === 'OTA') prob -= 2.7;
  else if (segment === 'B2B') prob -= 2.8;
  else if (segment === 'TO') prob -= 6.2;

  // 3. Lead Time adjustments
  if (leadTime <= 7) {
    prob += 0.0;
  } else if (leadTime <= 30) {
    prob += 7.0; // Higher risk for 8-30 days
  } else if (leadTime <= 90) {
    prob -= 1.0;
  } else {
    prob -= 5.0; // 90+ days has lower cancellation rate
  }

  // 4. Price adjustments (expected average per room category)
  let expectedAvg = 1756;
  if (roomCategory === 'Family') expectedAvg = 3762;
  else if (roomCategory === 'Suite') expectedAvg = 3332;
  else if (roomCategory === 'Autre') expectedAvg = 1687;

  if (price > expectedAvg) {
    const diffPct = (price - expectedAvg) / expectedAvg;
    prob += Math.min(15.0, diffPct * 10); // cap price penalty at +15%
  } else if (price < expectedAvg && price > 0) {
    const diffPct = (expectedAvg - price) / expectedAvg;
    prob -= Math.min(8.0, diffPct * 5); // cap price credit at -8%
  }

  // 5. Size adjustments
  if (adults + children > 4) {
    prob += 3.0; // larger groups slightly more risk
  }

  // Cap between 1% and 99%
  const finalProb = Math.max(1.0, Math.min(99.0, parseFloat(prob.toFixed(1))));

  // Explanations
  let riskLevel = 'Low';
  if (finalProb > 45) riskLevel = 'High';
  else if (finalProb > 25) riskLevel = 'Medium';

  const riskFactors = [];
  const positiveFactors = [];

  if (leadTime > 7 && leadTime <= 30) riskFactors.push('Lead time is between 8-30 days (highest cancellation rate bucket).');
  if (['WEB', 'VCR', 'CRS', 'AVM'].includes(segment)) riskFactors.push(`Booking segment '${segment}' has historically high cancellation rates.`);
  if (price > expectedAvg * 1.2) riskFactors.push(`Booking price (${price} MAD) is significantly higher than the average for ${roomCategory} rooms.`);
  
  if (roomCategory === 'Suite' || roomCategory === 'Autre') positiveFactors.push(`${roomCategory} category has very low cancellation rates.`);
  if (segment === 'TO' || segment === 'B2B') positiveFactors.push(`Booking segment '${segment}' is traditionally more stable.`);
  if (leadTime > 90) positiveFactors.push('Lead time is over 90 days, which historically shows higher commitment.');
  if (price < expectedAvg * 0.8) positiveFactors.push('Favorable booking price reduces cancellation likelihood.');

  return {
    probability: finalProb,
    riskLevel,
    riskFactors: riskFactors.length > 0 ? riskFactors : ['None identified'],
    positiveFactors: positiveFactors.length > 0 ? positiveFactors : ['Standard booking profile']
  };
}

// REST API Endpoints
// 1. Get KPIs
app.get('/api/kpis', async (req, res) => {
  try {
    const kpis = await getKPIs();
    res.json(kpis);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch KPIs', details: error.message });
  }
});

// 2. Get Aggregated Chart Analytics
app.get('/api/analytics', async (req, res) => {
  try {
    const analytics = await getAnalytics();
    res.json(analytics);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch analytics', details: error.message });
  }
});

// 3. Search and paginated list of reservations
app.get('/api/reservations', async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const search = req.query.search || '';
    const status = req.query.status || '';
    const category = req.query.category || '';
    const segment = req.query.segment || '';

    const results = await queryReservations({ page, limit, search, status, category, segment });
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: 'Failed to query reservations', details: error.message });
  }
});

// 4. Create new reservation
app.post('/api/reservations', async (req, res) => {
  try {
    const newRes = await createReservation(req.body);
    res.status(201).json(newRes);
  } catch (error) {
    res.status(400).json({ error: 'Failed to create reservation', details: error.message });
  }
});

// 5. Update reservation status or details
app.put('/api/reservations/:id', async (req, res) => {
  try {
    const updated = await updateReservation(req.params.id, req.body);
    if (!updated) {
      return res.status(404).json({ error: 'Reservation not found' });
    }
    res.json(updated);
  } catch (error) {
    res.status(400).json({ error: 'Failed to update reservation', details: error.message });
  }
});

// 6. Delete reservation
app.delete('/api/reservations/:id', async (req, res) => {
  try {
    const deleted = await deleteReservation(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Reservation not found' });
    }
    res.json({ message: 'Reservation deleted successfully', reservation: deleted });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete reservation', details: error.message });
  }
});

// 7. Cancellation predictor endpoint
app.post('/api/predict', (req, res) => {
  try {
    const prediction = predictCancellation(req.body);
    res.json(prediction);
  } catch (error) {
    res.status(400).json({ error: 'Failed to calculate prediction', details: error.message });
  }
});

// 8. AI Chatbot endpoint
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    // Fetch live KPIs to inject as context
    let kpiContext = '';
    try {
      const kpis = await getKPIs();
      kpiContext = `
Live hotel KPI data (as of now):
- Total bookings: ${kpis.total_bookings?.toLocaleString()}
- Total cancellations: ${kpis.total_cancellations?.toLocaleString()}
- Cancellation rate: ${(kpis.cancellation_rate * 100).toFixed(1)}%
- Total revenue (checked-out): ${kpis.total_revenue?.toLocaleString()} MAD
- Average night price (ADR): ${kpis.average_adr?.toFixed(0)} MAD
- Average lead time: ${kpis.average_lead_time?.toFixed(1)} days
- Average stay: ${kpis.average_nights?.toFixed(1)} nights
`;
    } catch (e) { /* continue without KPI context */ }

    const systemPrompt = `You are an intelligent hotel analytics assistant for Valeria Madina Club Resort.
Your role is to help hotel managers understand their reservation data, cancellation trends, revenue performance, and operational insights.
You are friendly, professional, concise and data-driven. Always respond in the same language the user writes in.
When asked about data, refer to the live KPIs provided. When asked for advice, give actionable hotel-industry recommendations.
${kpiContext}
Do not reveal the raw API key or any system internals. Focus on being a helpful analytics assistant.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.slice(-12) // keep last 12 messages for context window
      ],
      max_tokens: 500,
      temperature: 0.7,
    });

    const reply = completion.choices[0]?.message?.content ?? 'No response.';
    res.json({ reply });
  } catch (error) {
    console.error('Chat error:', error.message);
    res.status(500).json({ error: 'Chat failed', details: error.message });
  }
});


// Database Connection & Server Startup
async function startServer() {
  let mongoConnected = false;
  
  try {
    console.log(`🔌 Attempting database connection to: ${MONGODB_URI}`);
    // Connect with a 3-second timeout so it fails quickly and starts in CSV-fallback mode
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 3000
    });
    console.log('✅ MongoDB connected successfully!');
    mongoConnected = true;
  } catch (error) {
    console.log('⚠️ MongoDB connection failed. Starting server in CSV/In-Memory fallback mode.');
    console.log(`ℹ️ Fallback Reason: ${error.message}`);
  }

  // Load CSV and synchronize (either to DB or in-memory arrays)
  try {
    await initializeData(mongoConnected);
    
    app.listen(PORT, () => {
      console.log(`🚀 Hotel Dashboard API listening on port ${PORT}`);
      console.log(`🌐 Server Mode: ${mongoConnected ? 'MongoDB Live' : 'CSV In-Memory Fallback'}`);
    });
  } catch (error) {
    console.error('❌ Critical Error: Failed to initialize data and start server.', error);
    process.exit(1);
  }
}

startServer();

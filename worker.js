// Cloudflare Worker for FoxiMed Voice Logs
// D1 binding: DB
// Environment variable: ALLOWED_ORIGINS (comma-separated)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = request.headers.get('Origin') || '';

    // CORS configuration
    const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim());
    const corsOrigin = allowedOrigins.includes(origin) ? origin : (allowedOrigins[0] || '*');
    const corsHeaders = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (!env.DB) {
      return new Response(JSON.stringify({ error: 'Database not bound' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Health check
    if (path === '/health' && request.method === 'GET') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Voice log endpoint
    if (path === '/voice-log' && request.method === 'POST') {
      try {
        const body = await request.json();
        let logs = Array.isArray(body) ? body : [body];

        // Validate minimum required fields
        const validLogs = logs.filter(log => {
          return log.transcript && typeof log.transcript === 'string' && log.transcript.trim().length > 0
                 && log.client_generated_id && typeof log.client_generated_id === 'string' && log.client_generated_id.length > 0;
        });

        if (validLogs.length === 0) {
          return new Response(JSON.stringify({ error: 'No valid logs provided (require transcript and client_generated_id)' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const inserted = await insertLogs(env.DB, validLogs);
        return new Response(JSON.stringify({ success: true, inserted }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // Correction endpoint
    if (path === '/correction' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { logId, correctedTranscript, correctedIntent, notes } = body;
        if (!logId || !correctedTranscript) {
          return new Response(JSON.stringify({ error: 'Missing logId or correctedTranscript' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        const result = await insertCorrection(env.DB, logId, correctedTranscript, correctedIntent, notes);
        return new Response(JSON.stringify({ success: true, id: result }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // Stats endpoint
    if (path === '/stats' && request.method === 'GET') {
      try {
        const stats = await getStats(env.DB);
        return new Response(JSON.stringify(stats), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  },
};

// ─── Database Operations ──────────────────────────────────────────

async function insertLogs(db, logs) {
  let inserted = 0;
  for (const log of logs) {
    const {
      client_generated_id,
      transcript,
      normalized = null,
      winner = null,
      scores = null,
      entities = null,
      success = null,
      version = null,
      timestamp = new Date().toISOString(),
    } = log;

    // Check if this UUID already exists (idempotency)
    const existing = await db.prepare(
      'SELECT id FROM voice_logs WHERE client_generated_id = ?'
    ).bind(client_generated_id).first();

    if (existing) {
      // Already inserted; skip
      continue;
    }

    const scoresJson = scores ? JSON.stringify(scores) : null;
    const entitiesJson = entities ? JSON.stringify(entities) : null;

    const stmt = db.prepare(`
      INSERT INTO voice_logs
        (client_generated_id, transcript, normalized, winner, scores, entities, success, version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = await stmt.bind(
      client_generated_id,
      transcript,
      normalized,
      winner,
      scoresJson,
      entitiesJson,
      success === undefined ? null : success ? 1 : 0,
      version || null,
      timestamp
    ).run();

    if (result.success) inserted++;
  }
  return inserted;
}

async function insertCorrection(db, logId, correctedTranscript, correctedIntent, notes) {
  // logId is the client_generated_id (UUID) – we need to find the internal id
  const log = await db.prepare('SELECT id FROM voice_logs WHERE client_generated_id = ?')
    .bind(logId).first();
  if (!log) {
    throw new Error('Log not found');
  }
  const internalId = log.id;

  const stmt = db.prepare(`
    INSERT INTO voice_corrections (log_id, corrected_transcript, corrected_intent, notes, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = await stmt.bind(
    internalId,
    correctedTranscript,
    correctedIntent || null,
    notes || null,
    new Date().toISOString()
  ).run();
  return result.meta?.last_row_id || null;
}

async function getStats(db) {
  const totalLogs = await db.prepare('SELECT COUNT(*) as count FROM voice_logs').first();
  const successCount = await db.prepare('SELECT COUNT(*) as count FROM voice_logs WHERE success = 1').first();
  const topIntents = await db.prepare(
    `SELECT winner, COUNT(*) as count FROM voice_logs WHERE winner IS NOT NULL GROUP BY winner ORDER BY count DESC LIMIT 10`
  ).all();
  const dailyTrend = await db.prepare(
    `SELECT DATE(created_at) as day, COUNT(*) as count FROM voice_logs WHERE created_at >= DATE('now', '-7 days') GROUP BY day ORDER BY day DESC`
  ).all();
  return {
    total: totalLogs?.count || 0,
    successRate: totalLogs?.count ? ((successCount?.count || 0) / totalLogs.count * 100) : 0,
    topIntents: topIntents.results || [],
    dailyTrend: dailyTrend.results || [],
  };
}

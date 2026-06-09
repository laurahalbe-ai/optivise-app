export const config = { maxDuration: 60 }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { url, client } = req.body || {}
  if (!url) return res.status(400).json({ error: 'URL fehlt' })

  const ANTHROPIC_KEY = process.env.VITE_ANTHROPIC_API_KEY
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API Key fehlt' })

  const c = client || {}
  const tones = (c.tones || []).join(', ') || 'n/a'

  try {
    // 1. Fetch HTML
    let html = '', httpStatus = null, loadTimeMs = null, fetchError = null
    try {
      const start = Date.now()
      const pageRes = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Optivise-Audit/1.0)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(12000)
      })
      loadTimeMs = Date.now() - start
      httpStatus = pageRes.status
      html = await pageRes.text()
    } catch (e) { fetchError = e.message }

    // 2. Extract technical info from HTML
    const tech = html ? extractTech(html, url) : null

    // 3. Build prompt
    const techSummary = fetchError
      ? `FEHLER beim Laden der Seite: ${fetchError}`
      : `TECHNISCHE ANALYSE (automatisch aus HTML extrahiert):
- HTTP Status: ${httpStatus} ${httpStatus === 200 ? '✓' : '⚠️ Problem!'}
- Ladezeit: ${loadTimeMs}ms ${loadTimeMs > 3000 ? '⚠️ zu langsam' : '✓'}
- HTTPS: ${tech?.hasHttps ? '✓' : '✗ fehlt – kritisch!'}
- Seiten-Titel: ${tech?.pageTitle || '✗ fehlt'} ${tech?.pageTitle && /lp|landingpage|funnel/i.test(tech.pageTitle) ? '⚠️ enthält LP/Funnel-Begriff' : ''}
- Meta Description: ${tech?.metaDescription ? `✓ "${tech.metaDescription.slice(0,80)}..."` : '✗ fehlt'}
- Favicon: ${tech?.hasFavicon ? `✓ (${tech.faviconUrl || 'vorhanden'})` : '✗ fehlt'}
- Impressum: ${tech?.hasImpressum ? '✓ gefunden' : '✗ nicht gefunden'}
- Datenschutz: ${tech?.hasDatenschutz ? '✓ gefunden' : '✗ nicht gefunden'}
- URL Funnel-Keywords: ${tech?.urlFunnelKeywords?.length ? '✗ ' + tech.urlFunnelKeywords.join(', ') : '✓ keine'}
- Platzhalter im HTML: ${tech?.placeholders?.length ? '✗ gefunden: ' + tech.placeholders.join(', ') : '✓ keine'}
- Formulare: ${tech?.formCount || 0}
- Buttons: ${tech?.buttonCount || 0}
- Open Graph Tags: ${tech?.hasOgTags ? '✓' : '⚠️ fehlen'}
- Google Analytics: ${tech?.hasGoogleAnalytics ? '✓' : '–'}
- Facebook Pixel: ${tech?.hasPixel ? '✓' : '–'}`

    const prompt = `Du bist ein Senior QA-Experte für Landing Pages – sowohl technisch als auch visuell/conversion-seitig.

KUNDENPROFIL:
- Kunde: ${c.name || 'unbekannt'} | Branche: ${c.industry || 'n/a'}
- Zielgruppe: ${c.audience || 'n/a'} | LP-Ziel: ${c.goal || 'n/a'}
- USP: ${c.usp || 'n/a'}
- CI-Farben: Primär ${c.color_primary || 'n/a'}, Sekundär ${c.color_secondary || 'n/a'}, Akzent ${c.color_accent || 'n/a'}
- Schrift: ${c.font || 'n/a'} | Tonalität: ${tones}
- Verbote: ${c.donts || 'keine'}

${[...(c.feedback_internal||[]).slice(0,5).map(f=>`- [Team/${f.category}] ${f.text}`),...(c.feedback_client||[]).slice(0,5).map(f=>`- [Kunde/${f.category}] ${f.text}`)].length ? `GELERNTES FEEDBACK:\n${[...(c.feedback_internal||[]).slice(0,5).map(f=>`- [Team/${f.category}] ${f.text}`),...(c.feedback_client||[]).slice(0,5).map(f=>`- [Kunde/${f.category}] ${f.text}`)].join('\n')}` : ''}

${techSummary}

LANDINGPAGE CHECKLISTE – prüfe technisch (aus HTML-Daten oben) UND visuell (aus Screenshot falls vorhanden):
□ HTTP 200, HTTPS aktiv, Ladezeit < 3s
□ Favicon als Logo-PNG hinterlegt
□ Meta Description: 1-2 Sätze, Inhalt & Zielgruppe
□ Seitenname ohne LP/Landingpage/Funnel
□ Keine Platzhaltertexte
□ Impressum und Datenschutz verlinkt und erreichbar
□ URL ohne Funnel-Begriffe
□ SEO/OG Tags vorhanden
□ CI-Farben korrekt: ${c.color_primary}, ${c.color_secondary}, ${c.color_accent}
□ Schrift "${c.font||'n/a'}", max. 2 Schriftarten
□ Kein Waisenkind, Headlines max. 2 Zeilen
□ Hoher Kontrast, Abstände einheitlich
□ CTA above fold, Buttons einheitlich
□ Kein Onepage-Branding sichtbar

CONVERSION-ANALYSE:
- Hauptbotschaft in 3 Sekunden klar?
- CTA stark und prominent?
- Trust-Signale vorhanden?
- Headline überzeugend für "${c.audience || 'n/a'}"?

WICHTIG: Sei wohlwollend. Nur eindeutige Probleme als Fehler. Unsicherheiten als "hint".

FREIGABE: approved=true bei max. 2 Warnungen, keinen Fehlern.

Antworte NUR mit JSON:
{"approved":true,"verdict_headline":"1 Satz","verdict_reason":"1-2 Sätze","score":85,"issues":[{"type":"error|warning|cro|ci|copy|hint","category":"Technisch|LP|CI|CRO|Copy","title":"...","description":"konkret was gefunden/gesehen","fix":"Maßnahme"}]}`

    // 4. Build message parts
    const parts = [{ type: 'text', text: prompt }]

    // 5. Call Claude
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, messages: [{ role: 'user', content: parts }] })
    })

    if (!claudeRes.ok) {
      const err = await claudeRes.text()
      return res.status(500).json({ error: `Claude Fehler: ${claudeRes.status} – ${err.slice(0,200)}` })
    }

    const data = await claudeRes.json()
    const txt = data.content?.map(b => b.text || '').join('') || ''
    let parsed
    try { parsed = JSON.parse(txt.replace(/```json|```/g, '').trim()) } catch { parsed = null }

    return res.status(200).json({
      success: true,
      result: parsed,
      tech
    })

  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}

function extractTech(html, url) {
  const t = {}
  const metaDesc = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i)
  t.metaDescription = metaDesc?.[1] || null
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  t.pageTitle = title?.[1]?.trim() || null
  const favicon = html.match(/<link[^>]*rel=["'][^"']*icon[^"']*["'][^>]*>/i)
  t.hasFavicon = !!favicon
  t.faviconUrl = favicon?.[0]?.match(/href=["']([^"']+)["']/i)?.[1] || null
  t.hasImpressum = /impressum/i.test(html)
  t.hasDatenschutz = /datenschutz|privacy/i.test(html)
  t.placeholders = [/lorem ipsum/i, /\[name\]/i, /\[text\]/i, /mustermann/i].filter(p => p.test(html)).map(p => p.source.replace(/\\/g,'').replace(/\//g,'').replace('i',''))
  t.urlFunnelKeywords = ['leadmagnet','autowebinar','funnel','landingpage','/lp/'].filter(k => url.toLowerCase().includes(k))
  t.hasHttps = url.startsWith('https://')
  t.hasOgTags = /<meta[^>]*property=["']og:/i.test(html)
  t.formCount = (html.match(/<form/gi) || []).length
  t.buttonCount = (html.match(/<button/gi) || []).length
  t.hasGoogleAnalytics = /gtag\(|UA-|G-[A-Z0-9]/i.test(html)
  t.hasPixel = /fbq\(/i.test(html)
  return t
}

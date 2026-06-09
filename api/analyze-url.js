export const config = { maxDuration: 60 }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { url, client, extractProfile } = req.body || {}
  if (!url) return res.status(400).json({ error: 'URL fehlt' })

  const ANTHROPIC_KEY = process.env.VITE_ANTHROPIC_API_KEY
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API Key fehlt' })

  try {
    // 1. Fetch HTML
    let html = '', httpStatus = null, loadTimeMs = null, fetchError = null
    try {
      const start = Date.now()
      const pageRes = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(12000)
      })
      loadTimeMs = Date.now() - start
      httpStatus = pageRes.status
      html = await pageRes.text()
    } catch (e) { fetchError = e.message }

    // 2. Profile extraction mode
    if (extractProfile) {
      if (fetchError) return res.status(200).json({ error: `Seite nicht erreichbar: ${fetchError}` })

      const tech = extractTech(html, url)
      const onepage = extractOnepageData(html)

      const prompt = `Analysiere diesen HTML-Code und extrahiere Informationen für ein Marketing-Kundenprofil.
URL: ${url}
HTML (erste 10000 Zeichen): ${html.slice(0, 10000)}
${onepage.isOnepage ? `\nDiese Seite wurde mit Onepage.io erstellt. Erkannte Daten:\n${JSON.stringify(onepage, null, 2)}` : ''}

Extrahiere:
- name: Firmenname (aus Titel, Logo-Alt, H1 oder Meta)
- industry: Branche (E-Commerce / SaaS / Software / Gesundheit & Beauty / Finance / Versicherung / Immobilien / Bildung / B2B Services / Gastronomie / Retail / Sonstige)
- audience: Zielgruppe (kurz, 1 Satz)
- usp: Kernbotschaft aus der Haupt-Headline
- color_primary: Primärfarbe als Hex (aus CSS oder Inline-Styles)
- color_secondary: Sekundärfarbe als Hex
- color_accent: Akzentfarbe als Hex (Button-Farbe)
- font: Hauptschrift (aus font-family CSS)

JSON ohne Backticks: {"name":"...","industry":"...","audience":"...","usp":"...","color_primary":"#...","color_secondary":"#...","color_accent":"#...","font":"..."}`

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 500, messages: [{ role: 'user', content: prompt }] })
      })
      if (!r.ok) throw new Error(`Claude ${r.status}`)
      const d = await r.json()
      const txt = d.content?.map(b => b.text || '').join('') || ''
      let profile
      try { profile = JSON.parse(txt.replace(/```json|```/g, '').trim()) } catch { profile = null }
      if (!profile) return res.status(200).json({ error: 'Profil konnte nicht extrahiert werden' })
      return res.status(200).json({ success: true, profile })
    }

    // 3. Full LP audit mode
    const tech = fetchError ? null : extractTech(html, url)
    const onepage = html ? extractOnepageData(html) : {}

    // 4. Screenshot via thum.io (server-side)
    let screenshotB64 = null, screenshotType = 'image/jpeg'
    try {
      const imgRes = await fetch(`https://image.thum.io/get/width/1280/crop/900/noanimate/${encodeURIComponent(url)}`, {
        signal: AbortSignal.timeout(15000)
      })
      if (imgRes.ok) {
        const buf = await imgRes.arrayBuffer()
        if (buf.byteLength > 5000) {
          screenshotB64 = Buffer.from(buf).toString('base64')
          screenshotType = imgRes.headers.get('content-type') || 'image/jpeg'
        }
      }
    } catch {}

    const c = client || {}
    const tones = (c.tones || []).join(', ') || 'n/a'
    const fb = [...(c.feedback_internal||[]).slice(0,5).map(f=>`- [Team/${f.category}] ${f.text}`),...(c.feedback_client||[]).slice(0,5).map(f=>`- [Kunde/${f.category}] ${f.text}`)].join('\n')

    const techBlock = fetchError
      ? `FEHLER beim Laden: ${fetchError}`
      : `TECHNISCHE ANALYSE (automatisch aus HTML):
- HTTP Status: ${httpStatus} ${httpStatus === 200 ? '✓' : '⚠ Problem!'}
- Ladezeit: ${loadTimeMs}ms ${loadTimeMs > 3000 ? '⚠ zu langsam (>3s)' : '✓'}
- HTTPS: ${tech?.hasHttps ? '✓' : '✗ fehlt – kritisch!'}
- Seiten-Titel: ${tech?.pageTitle || '✗ fehlt'} ${tech?.pageTitle && /lp|landingpage|funnel/i.test(tech.pageTitle) ? '⚠ enthält LP/Funnel-Begriff' : ''}
- Meta Description: ${tech?.metaDescription ? `✓ "${tech.metaDescription.slice(0,80)}"` : '✗ fehlt'}
- Favicon: ${tech?.hasFavicon ? `✓` : '✗ fehlt'}
- Impressum: ${tech?.hasImpressum ? '✓' : '✗ nicht gefunden'}
- Datenschutz: ${tech?.hasDatenschutz ? '✓' : '✗ nicht gefunden'}
- Platzhalter: ${tech?.placeholders?.length ? '✗ gefunden: ' + tech.placeholders.join(', ') : '✓ keine'}
- URL Funnel-Keywords: ${tech?.urlFunnelKeywords?.length ? '✗ ' + tech.urlFunnelKeywords.join(', ') : '✓ keine'}
- OG Tags: ${tech?.hasOgTags ? '✓' : '⚠ fehlen'}
- Google Analytics: ${tech?.hasGoogleAnalytics ? '✓' : '–'}
- Facebook Pixel: ${tech?.hasPixel ? '✓' : '–'}
${onepage.isOnepage ? `\nONEPAGE.IO ERKANNT:
- Branding aktiv: ${onepage.brandingActive ? '✗ JA – muss deaktiviert werden' : '✓ deaktiviert'}
- Modalboxen umbenannt: ${onepage.modalboxesRenamed !== false ? '✓' : '⚠ prüfen'}
- SEO-Daten: ${onepage.seoSet ? '✓' : '⚠ prüfen'}` : ''}`

    const prompt = `Du bist ein erfahrener QA-Experte für Landing Pages – du entscheidest klar ob etwas FREIGABE bekommt.

KUNDENPROFIL:
- Kunde: ${c.name || '?'} | Branche: ${c.industry || 'n/a'} | Ziel: ${c.goal || 'n/a'}
- Zielgruppe: ${c.audience || 'n/a'} | USP: ${c.usp || 'n/a'}
- CI-Farben: Primär ${c.color_primary || 'n/a'}, Sekundär ${c.color_secondary || 'n/a'}, Akzent ${c.color_accent || 'n/a'}
- Schrift: ${c.font || 'n/a'} | Tonalität: ${tones} | Verbote: ${c.donts || 'keine'}
${fb ? `\nGELERNTES FEEDBACK:\n${fb}` : ''}

${techBlock}

VOLLSTÄNDIGE LP-CHECKLISTE (28 Punkte):
1. Onepage Branding deaktiviert | 2. Favicon als Logo-PNG mit transparentem Hintergrund
3. Meta Description: 1-2 Sätze | 4. Seitenname ohne LP/Funnel-Begriffe
5. Keine Platzhaltertexte | 6. CI-Farben korrekt (${c.color_primary||'n/a'}, ${c.color_secondary||'n/a'}, ${c.color_accent||'n/a'})
7. CI-Logo | 8. CI-Schrift "${c.font||'n/a'}", max. 2 Schriftarten
9. Buchstabenabstände einheitlich | 10. Zeilenabstand 1–1,5 | 11. Hoher Kontrast
12. Zeilenumbrüche sinnvoll | 13. Kein Waisenkind | 14. Headlines max. 2 Zeilen
15. Headlines größer/dicker als Text | 16. Einheitliche Schriftgrößen
17. Abstände einheitlich | 18. Einheitliche Headline-Formatierung
19. Max. 1 Hervorhebung pro Headline | 20. Textgröße mind. 16px (visuell)
21. Section-Abstände einheitlich | 22. Inhaltsbreite 1250–1400px
23. Kein leerer Bereich im 2-Spalten-Layout | 24. Buttons einheitlich, keine übertriebene Animation
25. Onepage-Link bei Modal-Buttons entfernt | 26. Impressum + Datenschutz erreichbar
27. Emojis/Icons passen zum Text | 28. URL ohne Funnel-Begriffe

CONVERSION: Hauptbotschaft klar? CTA prominent? Trust-Signale?

VERHALTEN:
- Schriftgrößen NUR visuell beurteilen, KEINE px-Zahlen nennen
- Kontrast nur bemängeln wenn wirklich unleserlich
- Wohlwollend – nur echte Probleme als Fehler
- Unsicherheit → type="hint" (zählt nicht zur Ablehnung)

FREIGABE: approved=true bei max. 2 Warnungen, keinen Fehlern.

JSON (keine Backticks):
{"approved":true,"verdict_headline":"1 klarer Satz","verdict_reason":"1-2 Sätze","score":85,"issues":[{"type":"error|warning|cro|ci|copy|hint","category":"Technisch|LP|CI|CRO|Copy","title":"...","description":"konkret was gefunden","fix":"Maßnahme"}]}`

    const parts = [{ type: 'text', text: prompt }]
    if (screenshotB64) {
      parts.push({ type: 'text', text: 'Screenshot der Landing Page:' })
      parts.push({ type: 'image', source: { type: 'base64', media_type: screenshotType, data: screenshotB64 } })
    }

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, messages: [{ role: 'user', content: parts }] })
    })

    if (!claudeRes.ok) throw new Error(`Claude ${claudeRes.status}: ${(await claudeRes.text()).slice(0,200)}`)
    const data = await claudeRes.json()
    const txt = data.content?.map(b => b.text || '').join('') || ''
    let parsed
    try { parsed = JSON.parse(txt.replace(/```json|```/g, '').trim()) } catch { parsed = null }

    return res.status(200).json({ success: true, result: parsed, screenshotAvailable: !!screenshotB64, tech })

  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}

function extractTech(html, url) {
  const t = {}
  const md = html.match(/<meta[^>]*name=[\"']description[\"'][^>]*content=[\"']([^\"']+)[\"']/i)
    || html.match(/<meta[^>]*content=[\"']([^\"']+)[\"'][^>]*name=[\"']description[\"']/i)
  t.metaDescription = md?.[1] || null
  t.pageTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || null
  t.hasFavicon = /<link[^>]*rel=[\"'][^\"']*icon[^\"']*[\"']/i.test(html)
  t.hasImpressum = /impressum/i.test(html)
  t.hasDatenschutz = /datenschutz|privacy/i.test(html)
  t.placeholders = [/lorem ipsum/i, /\[name\]/i, /\[text\]/i, /mustermann/i, /placeholder/i]
    .filter(p => p.test(html)).map(p => p.source.replace(/\//g,'').replace('i',''))
  t.hasHttps = url.startsWith('https://')
  t.hasOgTags = /<meta[^>]*property=[\"']og:/i.test(html)
  t.urlFunnelKeywords = ['leadmagnet','autowebinar','funnel','landingpage','/lp/'].filter(k => url.toLowerCase().includes(k))
  t.hasGoogleAnalytics = /gtag\(|G-[A-Z0-9]/i.test(html)
  t.hasPixel = /fbq\(/i.test(html)
  return t
}

function extractOnepageData(html) {
  const isOnepage = /onepage\.io|data-section|\.op-section|onepager/i.test(html)
  if (!isOnepage) return { isOnepage: false }

  return {
    isOnepage: true,
    // Onepage branding: look for onepage logo/link in footer or watermark
    brandingActive: /onepage\.io(?!.*cdn)|powered by onepage|©.*onepage/i.test(html),
    // Modal boxes: check if they have meaningful names (not default)
    modalboxesRenamed: !(/modal[_-]?\d+|popup[_-]?\d+/i.test(html)),
    // SEO: check if og:title and og:description are set
    seoSet: /<meta[^>]*property=[\"']og:title[\"'][^>]*content=[\"'][^\"']{5,}/i.test(html),
    // URL: check section slugs for funnel keywords
    sectionSlugs: (html.match(/data-slug=[\"']([^\"']+)[\"']/gi) || []).map(m => m.match(/[\"']([^\"']+)[\"']/)?.[1]).filter(Boolean)
  }
}

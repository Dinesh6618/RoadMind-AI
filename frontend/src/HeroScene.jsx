import { useState } from 'react'

/** Window grid for the skyline, deterministic so it never flickers between renders. */
function buildings() {
  const out = []
  let x = -10, i = 0
  const heights = [118, 150, 96, 176, 128, 210, 140, 100, 184, 122, 160, 104, 196, 132]
  while (x < 650) {
    const w = 38 + ((i * 17) % 34)
    const h = heights[i % heights.length]
    out.push({ x, w, h, back: i % 2 === 0 })
    x += w - 4
    i++
  }
  return out
}

const DASHES = Array.from({ length: 8 }, (_, i) => {
  const t0 = Math.pow(i / 8, 1.7), t1 = Math.pow((i + 0.55) / 8, 1.7)
  const y0 = 266 + 250 * t0, y1 = 266 + 250 * t1
  const hw = (t) => 1.2 + 9 * t
  return `${340 - hw(t0)},${y0} ${340 + hw(t0)},${y0} ${340 + hw(t1)},${y1} ${340 - hw(t1)},${y1}`
})

/**
 * The landing-page hero: an illustrated city road at dusk with a pothole being detected. It is an illustration, not a
 * photograph. To use a real photo, put it at frontend/public/hero.jpg (it is picked up automatically).
 */
export default function HeroScene() {
  const [photo, setPhoto] = useState(false)
  return (
    <>
      <img src="/hero.jpg" alt="" hidden onLoad={() => setPhoto(true)} onError={() => setPhoto(false)} />
      {photo ? (
        <img className="scene" src="/hero.jpg" alt="A road with visible surface damage" />
      ) : (
        <svg className="scene" viewBox="0 0 640 520" role="img" aria-label="Illustration: a city road with a pothole outlined by an AI detection box">
          <defs>
            <linearGradient id="hs-sky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#d9d0ff" /><stop offset="0.55" stopColor="#efe9ff" /><stop offset="1" stopColor="#ffe6ec" />
            </linearGradient>
            <radialGradient id="hs-sun" cx="0.5" cy="0.5" r="0.5">
              <stop offset="0" stopColor="#fff" stopOpacity="0.95" /><stop offset="1" stopColor="#fff" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="hs-road" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#3a4577" /><stop offset="1" stopColor="#151b3d" />
            </linearGradient>
            <linearGradient id="hs-walk" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#cfc7ee" /><stop offset="1" stopColor="#a79bd8" />
            </linearGradient>
            <linearGradient id="hs-b1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#b9aeea" /><stop offset="1" stopColor="#d6cef6" /></linearGradient>
            <linearGradient id="hs-b2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#7c70c6" /><stop offset="1" stopColor="#a396df" /></linearGradient>
            <clipPath id="hs-clip"><rect width="640" height="520" rx="32" /></clipPath>
          </defs>
          <g clipPath="url(#hs-clip)">
            <rect width="640" height="520" fill="url(#hs-sky)" />
            <circle cx="470" cy="190" r="190" fill="url(#hs-sun)" />
            {buildings().map((b, i) => (
              <g key={i}>
                <rect x={b.x} y={266 - b.h * (b.back ? 1.12 : 0.82)} width={b.w} height={b.h * (b.back ? 1.12 : 0.82) + 4} rx="3" fill={b.back ? 'url(#hs-b1)' : 'url(#hs-b2)'} opacity={b.back ? 0.85 : 1} />
                {!b.back && Array.from({ length: Math.floor((b.h * 0.82) / 20) }, (_, r) => (
                  <g key={r} fill="#f4f0ff" opacity="0.55">
                    {Array.from({ length: Math.max(1, Math.floor(b.w / 14)) }, (_, c) => (
                      <rect key={c} x={b.x + 6 + c * 12} y={266 - b.h * 0.82 + 8 + r * 19} width="5" height="8" rx="1.5" />
                    ))}
                  </g>
                ))}
              </g>
            ))}
            <rect y="262" width="640" height="258" fill="url(#hs-walk)" />
            {/* road in perspective */}
            <polygon points="316,262 364,262 720,520 -80,520" fill="url(#hs-road)" />
            <polygon points="316,262 322,262 -80,520 -150,520" fill="#e9e4fb" opacity="0.9" />
            <polygon points="364,262 358,262 720,520 790,520" fill="#e9e4fb" opacity="0.9" />
            <polyline points="322,262 -40,520" stroke="#fff" strokeWidth="3" fill="none" opacity="0.85" />
            <polyline points="358,262 680,520" stroke="#fff" strokeWidth="3" fill="none" opacity="0.85" />
            {DASHES.map((p, i) => <polygon key={i} points={p} fill="#fcd34d" opacity="0.95" />)}
            {/* street lamps */}
            {[[88, 230, 1], [560, 236, 1], [200, 252, 0.7], [452, 254, 0.7]].map(([x, y, s], i) => (
              <g key={i} transform={`translate(${x} ${y}) scale(${s})`}>
                <rect x="-2" y="0" width="4" height="64" rx="2" fill="#5b4fb0" />
                <path d="M0 2 Q 18 -4 30 8" stroke="#5b4fb0" strokeWidth="4" fill="none" strokeLinecap="round" />
                <circle cx="30" cy="10" r="6" fill="#fff4c2" />
              </g>
            ))}
            {/* damage: crack + pothole */}
            <path d="M338 352 L322 380 L334 396 L312 420" stroke="#0c1130" strokeWidth="2.4" fill="none" strokeLinecap="round" opacity="0.8" />
            <ellipse cx="302" cy="436" rx="66" ry="19" fill="#4b5694" opacity="0.5" />
            <ellipse cx="302" cy="438" rx="58" ry="15" fill="#080c24" />
            <ellipse cx="294" cy="434" rx="38" ry="8" fill="#161d44" />
            {/* AI detection overlay */}
            <g>
              <rect x="226" y="396" width="152" height="70" rx="10" fill="rgba(124,92,255,0.14)" stroke="#7c5cff" strokeWidth="3" strokeDasharray="1 0" />
              {[[226, 396, 1, 1], [378, 396, -1, 1], [226, 466, 1, -1], [378, 466, -1, -1]].map(([x, y, dx, dy], i) => (
                <path key={i} d={`M${x} ${y + 18 * dy} V${y} H${x + 18 * dx}`} stroke="#5b3df5" strokeWidth="6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              ))}
              <g transform="translate(226 366)">
                <rect width="124" height="26" rx="13" fill="#5b3df5" />
                <circle cx="14" cy="13" r="5" fill="#7df0c3" />
                <text x="26" y="17.5" fontFamily="Plus Jakarta Sans Variable, system-ui, sans-serif" fontSize="12.5" fontWeight="700" fill="#fff">Pothole  0.93</text>
              </g>
            </g>
          </g>
        </svg>
      )}
    </>
  )
}

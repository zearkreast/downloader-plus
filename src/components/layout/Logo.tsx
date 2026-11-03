/**
 * The application mark: an eight-blade aperture with a plus in its opening.
 *
 * Same geometry as the generated app icon (`scripts/generate_icon.py`), worked
 * out here as vectors so it stays crisp at any size. The two are one shape
 * written twice, as is `extension/make-icons.mjs`, so a change to one has to be
 * made to all three.
 */

type Point = readonly [number, number];

const BLADES = 8;
// All as a fraction of the disc's diameter.
const INNER_R = 0.3;
const SEAM_W = 0.058;
const PLUS_SPAN = 0.3;
const PLUS_W = 0.1;

const VIEW = 48;
const CENTRE = VIEW / 2;
const RADIUS = (VIEW * 0.94) / 2;
const STEP = (2 * Math.PI) / BLADES;
// A flat edge of the opening faces up, so the plus sits square inside it.
const FIRST = -Math.PI / 2 + STEP;
const LIGHT = (-125 * Math.PI) / 180;

const EMBER = [255, 78, 44] as const;
const AMBER = [255, 168, 56] as const;

const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1];
const place = ([x, y]: Point) => `${(CENTRE + x).toFixed(3)} ${(CENTRE + y).toFixed(3)}`;

function colour(t: number) {
  const channel = (i: 0 | 1 | 2) => Math.round(EMBER[i] + (AMBER[i] - EMBER[i]) * t);
  return `rgb(${channel(0)} ${channel(1)} ${channel(2)})`;
}

function toRim(point: Point, along: Point): Point {
  const b = dot(point, along);
  const t = -b + Math.sqrt(b * b - dot(point, point) + RADIUS * RADIUS);
  return [point[0] + along[0] * t, point[1] + along[1] * t];
}

/**
 * A blade is what lies between two neighbouring edges of the opening, each
 * carried on past its corner, once half a seam is kept from both.
 */
function blade(index: number) {
  const normal = (i: number): Point => [Math.cos(FIRST + i * STEP), Math.sin(FIRST + i * STEP)];
  const along = (i: number): Point => [-Math.sin(FIRST + i * STEP), Math.cos(FIRST + i * STEP)];

  const diameter = RADIUS * 2;
  const apothem = diameter * INNER_R * Math.cos(STEP / 2);
  const halfSeam = (diameter * SEAM_W) / 2;
  const n1 = normal(index);
  const n2 = normal(index + 1);
  const c1 = apothem - halfSeam;
  const c2 = apothem + halfSeam;
  const det = n1[0] * n2[1] - n1[1] * n2[0];
  const tip: Point = [(c1 * n2[1] - c2 * n1[1]) / det, (n1[0] * c2 - n2[0] * c1) / det];

  const near = toRim(tip, along(index));
  const far = toRim(tip, along(index + 1));
  const middle = Math.atan2(near[1] + far[1], near[0] + far[0]);
  const end: Point = [RADIUS * Math.cos(middle), RADIUS * Math.sin(middle)];
  const lit = 0.5 + 0.5 * Math.cos(middle - LIGHT);

  return {
    path: `M${place(tip)}L${place(near)}A${RADIUS} ${RADIUS} 0 0 1 ${place(far)}Z`,
    from: tip,
    to: end,
    start: colour(lit * 0.35),
    stop: colour(0.35 + lit * 0.65),
  };
}

const PIECES = Array.from({ length: BLADES }, (_, index) => blade(index));
const PLUS_HALF = RADIUS * PLUS_SPAN;
const PLUS_ARM = RADIUS * PLUS_W;
const PLUS_CORNER = PLUS_ARM * 0.42;

export function Logo({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <defs>
        {PIECES.map((piece, index) => (
          <linearGradient
            key={index}
            id={`umd-blade-${index}`}
            x1={CENTRE + piece.from[0]}
            y1={CENTRE + piece.from[1]}
            x2={CENTRE + piece.to[0]}
            y2={CENTRE + piece.to[1]}
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor={piece.start} />
            <stop offset="1" stopColor={piece.stop} />
          </linearGradient>
        ))}
        <linearGradient
          id="umd-plus"
          x1={CENTRE - PLUS_HALF}
          y1={CENTRE - PLUS_HALF}
          x2={CENTRE + PLUS_HALF}
          y2={CENTRE + PLUS_HALF}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor={colour(1)} />
          <stop offset="1" stopColor={colour(0)} />
        </linearGradient>
      </defs>
      {PIECES.map((piece, index) => (
        <path key={index} d={piece.path} fill={`url(#umd-blade-${index})`} />
      ))}
      <g fill="url(#umd-plus)">
        <rect
          x={CENTRE - PLUS_HALF}
          y={CENTRE - PLUS_ARM}
          width={PLUS_HALF * 2}
          height={PLUS_ARM * 2}
          rx={PLUS_CORNER}
        />
        <rect
          x={CENTRE - PLUS_ARM}
          y={CENTRE - PLUS_HALF}
          width={PLUS_ARM * 2}
          height={PLUS_HALF * 2}
          rx={PLUS_CORNER}
        />
      </g>
    </svg>
  );
}

import * as React from "react";

import { cn } from "@/lib/utils";

type Point = [number, number];
type Box = [
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
];

// Isometric projection: x runs right-down, y left-down, z up.
const iso = (x: number, y: number, z: number): Point => [
  (x - y) * 0.866,
  (x + y) * 0.5 - z,
];

const points = (corners: Point[], s: number) =>
  corners
    .map(([x, y]) => `${(x * s).toFixed(1)},${(y * s).toFixed(1)}`)
    .join(" ");

/** Hatching that gets denser on faces turned away from the light, like an engraved plate. */
function Hatching({ id }: { id: string }) {
  return (
    <defs>
      {[
        ["t", 7, -30, 0.5],
        ["f", 3.4, 30, 0.75],
        ["s", 2.3, -30, 1],
        ["x", 2.3, 90, 0.6],
      ].map(([face, gap, angle, width]) => (
        <pattern
          key={face}
          id={`${id}${face}`}
          width={gap}
          height={gap}
          patternUnits="userSpaceOnUse"
          patternTransform={`rotate(${angle})`}
        >
          <line x2={gap} stroke="currentColor" strokeWidth={width} />
        </pattern>
      ))}
    </defs>
  );
}

function useHatchId() {
  return `brick${React.useId().replace(/[^a-zA-Z0-9]/g, "")}`;
}

function IsoBrick({
  id,
  box: [x0, x1, y0, y1, z0, z1],
  s,
  label,
}: {
  id: string;
  box: Box;
  s: number;
  label?: string;
}) {
  const face = (corners: [number, number, number][], hatch: string) => {
    const p = points(
      corners.map((c) => iso(...c)),
      s,
    );
    return (
      <>
        <polygon points={p} className="brick-paper" />
        <polygon
          points={p}
          fill={`url(#${id}${hatch})`}
          className="brick-edge"
        />
      </>
    );
  };
  const side: [number, number, number][] = [
    [x1, y0, z0],
    [x1, y1, z0],
    [x1, y1, z1],
    [x1, y0, z1],
  ];
  const [tx, ty] = iso(x0 + 0.3, y1, (z0 + z1) / 2);
  return (
    <>
      {face(
        [
          [x0, y0, z1],
          [x1, y0, z1],
          [x1, y1, z1],
          [x0, y1, z1],
        ],
        "t",
      )}
      {face(
        [
          [x0, y1, z0],
          [x1, y1, z0],
          [x1, y1, z1],
          [x0, y1, z1],
        ],
        "f",
      )}
      {face(side, "s")}
      <polygon
        points={points(
          side.map((c) => iso(...c)),
          s,
        )}
        fill={`url(#${id}x)`}
      />
      {label && (
        <g
          transform={`matrix(0.866,0.5,0,1,${(tx * s).toFixed(1)},${(ty * s).toFixed(1)})`}
        >
          <rect
            y={-11}
            width={label.length * 8.2 + 16}
            height={20}
            className="brick-paper brick-plaque"
          />
          <text x={8} y={3.5} className="brick-label">
            {label}
          </text>
        </g>
      )}
    </>
  );
}

/** Bounding box of a set of bricks in projected units, for a snug viewBox. */
function viewBoxOf(boxes: Box[], s: number, pad: number) {
  const pts = boxes.flatMap(([x0, x1, y0, y1, z0, z1]) =>
    [x0, x1].flatMap((x) =>
      [y0, y1].flatMap((y) => [z0, z1].map((z) => iso(x, y, z))),
    ),
  );
  const xs = pts.map(([x]) => x * s);
  const ys = pts.map(([, y]) => y * s);
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  return `${minX.toFixed(0)} ${minY.toFixed(0)} ${(Math.max(...xs) + pad - minX).toFixed(0)} ${(Math.max(...ys) + pad - minY).toFixed(0)}`;
}

const blocks = [
  ["ACTION", "RESOURCE", "COMMAND"],
  ["EVENT", "SOCKET"],
  ["MCP TOOL"],
];

/** Six building blocks in running bond. Each brick sets once on load; that is the hero's one animation. */
export function BrickPyramid({ className }: { className?: string }) {
  const id = useHatchId();
  const s = 58;
  const [L, W, H, g] = [2.5, 1, 0.78, 0.09];
  const bricks = blocks.flatMap((row, k) =>
    row.map((label, i) => {
      const x0 = (k * (L + g)) / 2 + i * (L + g);
      const z0 = k * (H + g * 0.6);
      return { label, box: [x0, x0 + L, 0, W, z0, z0 + H] as Box };
    }),
  );
  return (
    <svg
      viewBox={viewBoxOf(
        bricks.map((b) => b.box),
        s,
        4,
      )}
      className={cn("brick-art", className)}
      role="img"
      aria-label="Six bricks in running bond, labelled action, resource, command, event, socket and MCP tool"
    >
      <Hatching id={id} />
      {bricks.map(({ label, box }, n) => (
        <g
          key={label}
          className="brick-lay"
          style={{ animationDelay: `${n * 100}ms` }}
        >
          <IsoBrick id={id} box={box} s={s} label={label} />
        </g>
      ))}
    </svg>
  );
}

/** One engraved brick, for the closing call to action. */
export function BrickSingle({ className }: { className?: string }) {
  const id = useHatchId();
  const box: Box = [0, 2.5, 0, 1, 0, 0.8];
  return (
    <svg
      viewBox={viewBoxOf([box], 40, 4)}
      className={cn("brick-art", className)}
      aria-hidden="true"
    >
      <Hatching id={id} />
      <IsoBrick id={id} box={box} s={40} />
    </svg>
  );
}

/** A front-on engraved brick with a stamped plaque, for the table-to-browser course. */
export function BrickFront({ label }: { label: string }) {
  const id = useHatchId();
  const [w, h, dx, dy] = [196, 64, 16, 12];
  return (
    <svg
      viewBox={`0 ${-dy - 2} ${w + dx + 2} ${h + dy + 4}`}
      className="brick-art"
      aria-hidden="true"
    >
      <Hatching id={id} />
      <polygon
        points={`0,0 ${dx},${-dy} ${w + dx},${-dy} ${w},0`}
        className="brick-paper"
      />
      <polygon
        points={`0,0 ${dx},${-dy} ${w + dx},${-dy} ${w},0`}
        fill={`url(#${id}t)`}
        className="brick-edge"
      />
      <polygon
        points={`${w},0 ${w + dx},${-dy} ${w + dx},${h - dy} ${w},${h}`}
        className="brick-paper"
      />
      <polygon
        points={`${w},0 ${w + dx},${-dy} ${w + dx},${h - dy} ${w},${h}`}
        fill={`url(#${id}s)`}
        className="brick-edge"
      />
      <rect width={w} height={h} className="brick-paper brick-edge" />
      <rect
        x={16}
        y={h / 2 - 11}
        width={label.length * 8.4 + 18}
        height={22}
        className="brick-paper brick-plaque"
      />
      <text x={25} y={h / 2 + 4} className="brick-label">
        {label}
      </text>
    </svg>
  );
}

/** Running-bond courses curving edge to edge: the ground the hero stands on. */
export function BrickGround({ className }: { className?: string }) {
  const [w, h, rows] = [1196, 150, 5];
  const courses: { points: string; opacity: number }[] = [];
  let y = h;
  for (let r = 0; r < rows; r++) {
    const rh = 30 * 0.86 ** r;
    const bw = 92 * 0.9 ** r;
    const arc = (x: number) => 3 * (r + 2) * ((x - w / 2) / (w / 2)) ** 2;
    const top = y - rh;
    for (let x = r % 2 ? -bw / 2 : 0; x < w; x += bw) {
      const [xa, xb] = [x + 2, x + bw - 2];
      courses.push({
        points: [
          [xa, top + arc(xa)],
          [xb, top + arc(xb)],
          [xb, y - 2 + arc(xb)],
          [xa, y - 2 + arc(xa)],
        ]
          .map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`)
          .join(" "),
        opacity: Math.max(0.12, 0.75 - r * 0.075),
      });
    }
    y = top - 3;
  }
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="xMidYMax slice"
      className={cn("brick-ground", className)}
      aria-hidden="true"
    >
      {courses.map((c) => (
        <polygon
          key={c.points}
          points={c.points}
          strokeOpacity={c.opacity}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

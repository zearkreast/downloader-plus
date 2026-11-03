import { AnimatePresence, motion } from 'motion/react';

import { T } from '@/lib/motion';
import { IS_MOBILE } from '@/lib/platform';

/**
 * How a light thins out from its centre to its rim: a bell curve a third of
 * the radius wide, lowered by the little it still has at the rim so that it
 * ends at nothing. A straight fade leaves a bright point in the middle and a
 * ring where it stops; a bell has neither, so the glow shows no edge anywhere.
 */
function falloff(colour: string): string {
  const rim = Math.exp(-4.5);
  return Array.from({ length: 13 }, (_, i) => {
    const at = i / 12;
    const strength = (Math.exp(-4.5 * at * at) - rim) / (1 - rim);
    return `color-mix(in srgb, ${colour} ${(strength * 100).toFixed(1)}%, transparent) ${(at * 100).toFixed(1)}%`;
  }).join(', ');
}

/**
 * Two lights, the mark's two ends: amber falling from the upper left, ember
 * from the right, overlapping behind the headline and the field. Together
 * they are the mark's own gradient, spread across the window as a haze.
 */
const GLOW = [
  `radial-gradient(circle 70vmin at 38% 34%, ${falloff('var(--brand-amber)')})`,
  `radial-gradient(circle 80vmin at 64% 50%, ${falloff('var(--brand-ember)')})`,
].join(', ');

/**
 * The desktop's screens take turns -- the old one leaves before the new one
 * arrives -- so the light waits for Home as Home waits for the screen before
 * it. A phone's pass each other, and the light comes with Home from the start.
 */
const ARRIVE = IS_MOBILE ? T.spatial : { ...T.spatial, delay: T.spatialOut.duration };

/**
 * The backdrop of the Home screen: a soft glow in the mark's colours, centred
 * behind the headline and the URL field, which is where the eye already is. It is
 * faint enough that the text on it reads as it would on the flat page.
 *
 * It is a circle sized by the shorter side of the window, so it keeps its
 * shape everywhere. On a phone it spills past both edges as a haze rather than
 * fitting between them as a column of light; on the desktop it has all but
 * gone by the time it reaches the sidebar. It belongs to the window, not to
 * the page, so when a result takes the headline's place the light stays where
 * it was instead of scrolling away with it.
 *
 * It stands still. A single gradient is painted once and costs nothing after
 * that, which is why the phone and the desktop can share it. The one thing it
 * does is come and go with Home, at the pace of the screen change: switched
 * off the instant the route moved, it was gone while Home was still sliding
 * out on a phone, and was back at full strength before Home had faded in.
 * Opacity alone, so it is still a fade under the system's reduced motion, as
 * the screens are; the app's own Reduce motion stops it with everything else.
 */
export function Background({ active }: { active: boolean }) {
  return (
    <AnimatePresence initial={false}>
      {active && (
        <motion.div
          key="glow"
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: ARRIVE }}
          exit={{ opacity: 0, transition: T.spatialOut }}
        >
          {/* Faded as a whole by the layer above, so its own strength stays
              the one number that says how faint it is. */}
          <div
            className="absolute inset-0 opacity-[0.09] dark:opacity-[0.13]"
            style={{ backgroundImage: GLOW }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

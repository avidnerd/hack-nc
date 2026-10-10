/**
 * The two-fingertip caliper.
 *
 * Both endpoints are already in world millimetres by the time they reach here
 * (the gesture layer projects the fingertips onto the cutting plane, or onto
 * the volume's front surface when there is no plane), so the measurement is a
 * plain Euclidean distance. The honesty of the number comes from the
 * projection, not from the arithmetic.
 */

import { dist, type Vec3 } from '../coords.ts';

export function caliperMm(a: Vec3, b: Vec3): number {
  return dist(a, b);
}

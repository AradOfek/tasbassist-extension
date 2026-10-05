/**
 * NodDetector — head-nod gesture recognition for TabAssist.
 *
 * WHY THIS EXISTS
 * ---------------
 * A guitarist holding an instrument wants to advance the tab with a brief head
 * nod. The hard part is telling a *nod* apart from every other way a head moves,
 * because several of them look similar in raw face coordinates:
 *
 *   - Looking down at the fretboard  -> head pitches down and STAYS down
 *   - A head tilt (ear toward shoulder) -> head rolls, sweeping the nose sideways
 *   - Leaning or bobbing             -> whole head translates vertically
 *   - A real nod                     -> pitches down, then comes back up
 *
 * Only the last one should trigger a jump.
 *
 * THE SIGNAL
 * ----------
 * The obvious feature is the raw nose-tip Y from MediaPipe
 * (`landmarks[1].y`). It is a poor one, because it responds to all four motions
 * above. Rolling the head rotates the face about the skull's centre, which
 * sweeps the nose tip through an arc and changes its Y even though the player
 * never pitched at all.
 *
 * So instead we measure the nose tip relative to the eyes, along the face's own
 * "down" axis rather than the image's:
 *
 *     eyeMid  = midpoint(leftEye, rightEye)
 *     eyeLine = rightEye - leftEye
 *     down    = perpendicular(eyeLine), normalised
 *     signal  = dot(noseTip - eyeMid, down) / |eyeLine|
 *
 * The perpendicular is what makes this work. Simply subtracting the eye
 * midpoint's Y is *not* enough: that difference still shrinks by cos(roll) as
 * the head tilts, and at 30 degrees that is a 13% swing — larger than a 25
 * degree nod produces. Projecting onto the face's own axis cancels that exactly,
 * because a tilt rotates the eyes and the nose together and the projection onto
 * the rotated axis is unchanged.
 *
 * So the signal measures face *shape*, not face *position*:
 *
 *   - Roll-invariant. Exact, not approximate. See `maxRollDeg` for what the
 *     remaining guard is actually for.
 *   - Translation-invariant. Leaning or bobbing moves eyes and nose together,
 *     so it cancels entirely.
 *   - Distance-invariant. Dividing by interocular distance means leaning toward
 *     the camera does not change the sensitivity.
 *
 * Pitch survives in that fallback, but only weakly, and the reason sets the
 * scale of every fallback threshold below. Pitching rotates the face about an
 * axis through the eye midpoint, so the nose tip swings along an arc of radius
 * d (its resting distance below the eyes) and the signal becomes
 * d * cos(theta). Nodding *down* therefore *decreases* it, by only
 * d * (1 - cos theta):
 *
 *     pitch 15 deg ->  0.034 * d
 *     pitch 20 deg ->  0.060 * d
 *     pitch 25 deg ->  0.094 * d
 *     pitch 30 deg ->  0.134 * d
 *
 * Expressed as a fraction of interocular distance (d/eyeDist is roughly 0.58
 * for an adult face), a comfortable 25-degree nod moves the signal by only about
 * 0.05. That is an order of magnitude smaller than the old 0.040 threshold, and
 * keeping that threshold here is why normal nods stopped registering at all.
 *
 * THE PREFERRED SIGNAL
 * --------------------
 * MediaPipe can also report the face's rigid 3D orientation directly through
 * `facialTransformationMatrixes`. That matrix maps MediaPipe's canonical face
 * model to the observed face. Its third column is therefore the canonical
 * nose-forward axis expressed in runtime coordinates: the direction the nose is
 * actually pointing.
 *
 * Tracking that direction is a fundamentally better measurement than tracking a
 * projected eye-to-nose distance:
 *
 *   - Translation-invariant. Moving the whole head up, down, or toward the
 *     camera changes the matrix's translation and scale, not the direction of
 *     its third column.
 *   - Roll-invariant. Rolling the head rotates the face around its forward
 *     axis, leaving that axis itself unchanged.
 *   - Full-scale. A physical 20-degree nod changes this measurement by about
 *     20 degrees, instead of changing a projected face-shape proxy by a few
 *     hundredths of an eye distance.
 *
 * When a valid matrix is available, the detector uses nose pitch in degrees.
 * The older eye-shape signal remains only as a fallback when the matrix is
 * absent or malformed.
 *
 * WHY A STATE MACHINE
 * -------------------
 * The previous implementation used a single threshold with a baseline that kept
 * adapting mid-gesture. That is what caused the bug this file exists to fix.
 * For a downward step of depth D, an exponential baseline with alpha=0.05
 * converges as D * 0.95^n, so it falls back under the 0.040 threshold after
 *
 *     n = ln(0.040 / D) / ln(0.95)
 *
 * frames all by itself, with no upward head motion at all:
 *
 *     D = 0.050 ->  ~4 frames -> ~150 ms   FALSE JUMP
 *     D = 0.060 -> ~10 frames -> ~320 ms   FALSE JUMP
 *     D = 0.090 -> ~16 frames -> ~545 ms   correctly ignored
 *
 * The duration check did not save it, because it lived *inside* the "still
 * below threshold" branch, which this decay path never reached.
 *
 * The fix is to freeze the reference for the duration of the gesture and require
 * a genuine return. Three states, and two independent things must hold before we
 * fire: the head must come back up close to where it started (hysteresis), and
 * it must actually have gone down (minimum depth).
 *
 * SENSITIVITY AND CALIBRATION
 * --------------------------
 * Sensitivity scales the enter, exit, and minimum-depth thresholds together on
 * a 1-10 scale. Calibration supplies a better initial baseline for the
 * player's chosen posture. It intentionally does not freeze that baseline:
 * ordinary adaptation resumes immediately, so gradual posture changes remain
 * supported.
 */

const DEFAULT_OPTIONS = {
  // All distances below are in units of interocular distance (the gap between
  // the outer eye corners), not raw normalised pixels. That keeps the detector
  // equally sensitive whether the player is close to the camera or far from it,
  // and — more importantly — puts the numbers on the same scale as the signal
  // they are compared against. See the header note on the signal's travel.

  // How far the head must travel, as a fraction of interocular distance, to
  // count as entering a dip.
  //
  // These are small numbers because the signal barely moves: foreshortening
  // turns a 25-degree nod into roughly 9% of an eye-distance. A 20-degree nod
  // comes out around 6%, and 15 degrees around 3%. So enter sits just above a
  // gentle nod, and well below a decisive one.
  enterThreshold: 0.024,

  // The head must come back to within this fraction of where the dip started.
  // Far smaller than enterThreshold on purpose: that gap is what separates a
  // real upward return from a baseline that merely drifted.
  exitThreshold: 0.009,

  // A dip must reach at least this fraction of eye-distance to count, so a
  // threshold graze that never really went down cannot fire.
  minDepth: 0.018,

  // User-facing sensitivity on a 1-10 scale. Five is the default. Higher values
  // multiply every enter, exit, and minimum-depth threshold by a smaller
  // factor, so smaller nods count; lower values do the reverse. The multiplier
  // is intentionally modest because sensitivity should adjust deliberate
  // gestures, not turn tracking noise into jumps.
  sensitivity: 5,

  // The corresponding thresholds when nose pitch is available. These are in
  // degrees because the signal is a physical head angle, not a projected
  // distance. A gentle nod is around 10 degrees; a comfortable nod is around
  // 20 degrees.
  nosePitchEnterDeg: 7,
  nosePitchExitDeg: 2.5,
  nosePitchMinDepthDeg: 5,

  // A nod is quick. Past this, we assume the player is looking at their
  // instrument rather than gesturing.
  maxDurationMs: 400,

  // Lockout after firing, so one nod cannot be counted as several jumps.
  cooldownMs: 800,

  // How fast the baseline follows a resting position. Small = slow = stable.
  baselineAlpha: 0.05,

  // Light smoothing of the incoming fallback signal to suppress per-frame
  // jitter. Kept high (responsive) because that signal's total travel is so
  // small that heavy smoothing would swallow a quick nod entirely.
  signalAlpha: 0.7,

  // The nose-pitch signal moves on a physical-degree scale rather than a
  // hundredth-of-an-eye scale, so it can use steadier filtering without losing
  // a quick nod.
  nosePitchSignalAlpha: 0.55,
  nosePitchBaselineAlpha: 0.08,

  // Beyond this much roll we assume a head tilt and ignore the frame. Roll
  // perturbs the signal in the opposite direction to a nod, so this is a
  // backstop, not the primary defence.
  maxRollDeg: 25,

  // If the face vanishes mid-dip we cannot trust the gesture; abort it rather
  // than waiting out the timeout.
  faceLostGraceMs: 200,

  // After an aborted dip we ignore input until the head comes back up to the
  // pre-dip resting position. This is the fallback for when the player settles
  // into a permanently different posture, which the normal return path would
  // never satisfy. It is deliberately long: while the head is merely being held
  // down to look at the fretboard it is also perfectly still, so a short window
  // here would adopt the held-down position as the new normal and cost us the
  // next nod. The cost of waiting is only that a nod immediately after a very
  // long glance may be missed, and the baseline then self-corrects.
  rearmStillMs: 2000,

  // How little the fallback signal may move per frame to count as "still" for
  // the rearm check above, in eye-distance units. Sits comfortably above real
  // landmark jitter (well under 0.002) and far below any deliberate movement.
  stillTolerance: 0.004,

  // The corresponding stillness rate for nose pitch, in degrees per frame.
  nosePitchStillDegPerFrame: 0.75,
};

// Nominal frame interval at the capture rate popup.js requests. Only used to
// convert the still-frame count above into a duration.
const FRAME_INTERVAL_MS = 1000 / 30;

const STATE_IDLE = 'IDLE';
const STATE_DIPPING = 'DIPPING';
const STATE_COOLDOWN = 'COOLDOWN';
const STATE_DISARMED = 'DISARMED';

const MIN_SENSITIVITY = 1;
const MAX_SENSITIVITY = 10;
const DEFAULT_SENSITIVITY = 5;
// At 30 fps, this is roughly one second of holding the playing posture.
const CALIBRATION_TARGET_SAMPLES = 30;
const CALIBRATION_MAX_DEVIATION = {
  'nose-pitch': 1,
  'eye-shape': 0.008,
};

class NodDetector {
  /**
   * Extract nose pitch from a MediaPipe facial-transformation matrix.
   *
   * The matrix maps MediaPipe's canonical face model to the observed face. Its
   * third column is therefore the canonical nose-forward axis in runtime
   * coordinates. The returned angle is positive when the nose points down and
   * ignores the matrix's translation and uniform scale.
   *
   * @param {{rows: number, columns?: number, cols?: number, data: ArrayLike<number>}|null|undefined} matrix
   *        One entry from `facialTransformationMatrixes`. MediaPipe stores
   *        matrix data in column-major order.
   * @returns {number|null} Nose pitch in degrees, or null when unavailable.
   */
  static nosePitchFromFacialTransformationMatrix(matrix) {
    if (!matrix || typeof matrix !== 'object') {
      return null;
    }

    const rows = Number(matrix.rows);
    const columns = Number(matrix.columns ?? matrix.cols);
    const { data } = matrix;
    if (
      !Number.isFinite(rows) ||
      !Number.isFinite(columns) ||
      rows < 3 ||
      columns < 3 ||
      !data ||
      typeof data.length !== 'number' ||
      data.length < rows * columns
    ) {
      return null;
    }

    // Column-major storage: column c starts at c * rows.
    const forwardX = Number(data[2 * rows]);
    const forwardY = Number(data[2 * rows + 1]);
    const forwardZ = Number(data[2 * rows + 2]);
    if (!Number.isFinite(forwardX) || !Number.isFinite(forwardY) || !Number.isFinite(forwardZ)) {
      return null;
    }

    // In MediaPipe's metric space, y points up and z points away from the
    // camera. A face looking at the camera therefore has forward (0, 0, -1).
    // The vertical component of that vector gives downward-positive pitch
    // without using its horizontal component, so yaw does not leak into the
    // measurement.
    const length = Math.hypot(forwardX, forwardY, forwardZ);
    if (!(length > 0)) {
      return null;
    }

    const sine = Math.max(-1, Math.min(1, -forwardY / length));
    return (Math.asin(sine) * 180) / Math.PI;
  }

  /**
   * Check whether calibration samples are steady enough to use as a baseline.
   *
   * Calibration records the player's chosen idle posture; it does not lock
   * detection. The regular slowly adapting baseline continues afterward, so a
   * saved posture is a better starting point rather than a permanent constraint.
   *
   * @param {Array<number>} samples Signal samples in capture order.
   * @param {string} signalSource Either `nose-pitch` or `eye-shape`.
   * @returns {{ok: boolean, signalSource?: string, baseline?: number,
   *            sampleCount?: number, reason?: string}}
   */
  static summarizeCalibration(samples, signalSource) {
    if (signalSource !== 'nose-pitch' && signalSource !== 'eye-shape') {
      return { ok: false, reason: 'unknown-signal-source' };
    }
    if (!Array.isArray(samples)) {
      return { ok: false, reason: 'invalid-samples' };
    }

    const values = samples.filter(
      (value) => typeof value === 'number' && Number.isFinite(value)
    );
    if (values.length !== CALIBRATION_TARGET_SAMPLES) {
      return {
        ok: false,
        reason: 'not-enough-samples',
        received: values.length,
        needed: CALIBRATION_TARGET_SAMPLES,
      };
    }

    const baseline = values.reduce((total, value) => total + value, 0) / values.length;
    const maxDeviation = Math.max(
      ...values.map((value) => Math.abs(value - baseline))
    );
    if (maxDeviation > CALIBRATION_MAX_DEVIATION[signalSource]) {
      return {
        ok: false,
        reason: 'hold-still',
        maxDeviation,
        allowedDeviation: CALIBRATION_MAX_DEVIATION[signalSource],
      };
    }

    return {
      ok: true,
      signalSource,
      baseline,
      sampleCount: values.length,
      maxDeviation,
    };
  }

  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.reset();
  }

  /**
   * Change sensitivity while preserving baseline, smoothing, and detector state.
   *
   * @param {number} sensitivity Desired sensitivity from 1-10.
   * @returns {number} The normalized sensitivity actually stored.
   */
  setSensitivity(sensitivity) {
    const numeric = Math.round(Number(sensitivity));
    this.options.sensitivity = Number.isFinite(numeric)
      ? Math.min(MAX_SENSITIVITY, Math.max(MIN_SENSITIVITY, numeric))
      : DEFAULT_SENSITIVITY;
    return this.options.sensitivity;
  }

  /**
   * Set the resting baseline from a calibration capture.
   *
   * An in-flight gesture is discarded because the baseline it used is being
   * replaced. Afterwards the normal adaptive baseline resumes, so this records
   * a starting posture rather than freezing detection.
   *
   * @param {{signalSource: string, baseline: number}|null|undefined} calibration
   * @returns {boolean} Whether the calibration was accepted.
   */
  calibrateTo(calibration) {
    if (!calibration || typeof calibration !== 'object') {
      return false;
    }
    const { signalSource, baseline } = calibration;
    if (
      (signalSource !== 'nose-pitch' && signalSource !== 'eye-shape') ||
      typeof baseline !== 'number' ||
      !Number.isFinite(baseline)
    ) {
      return false;
    }

    this.reset();
    this.signalSource = signalSource;
    this.baseY = baseline;
    this.smoothY = baseline;
    this.prevY = baseline;
    this.lastSignal = baseline;
    if (signalSource === 'nose-pitch') {
      this.lastNosePitch = baseline;
    } else {
      this.lastEyeShape = baseline;
    }
    return true;
  }

  /**
   * Adopt a saved calibration only when live tracking is already near it.
   *
   * This prevents a stale saved posture from becoming a false dip when the
   * player starts in a substantially different position. When the posture is
   * far away, the caller should discard the saved value and use live tracking.
   *
   * @param {{signalSource: string, baseline: number}|null|undefined} calibration
   * @returns {boolean} Whether the saved baseline was adopted.
   */
  adoptCalibratedBaseline(calibration) {
    if (!calibration || typeof calibration !== 'object') {
      return false;
    }
    const { signalSource, baseline } = calibration;
    if (
      (signalSource !== 'nose-pitch' && signalSource !== 'eye-shape') ||
      typeof baseline !== 'number' ||
      !Number.isFinite(baseline) ||
      this.signalSource !== signalSource ||
      typeof this.lastSignal !== 'number' ||
      !Number.isFinite(this.lastSignal)
    ) {
      return false;
    }

    const thresholds = this.#thresholdsForSource(signalSource === 'nose-pitch');
    if (Math.abs(this.lastSignal - baseline) > thresholds.enter) {
      return false;
    }
    return this.calibrateTo(calibration);
  }

  /** Returns the detector to its just-started condition. */
  reset() {
    this.state = STATE_IDLE;
    this.signalSource = 'eye-shape';
    this.activeThresholds = null;
    this.baseY = null;       // slowly-adapting resting signal
    this.dipRef = null;      // baseline frozen at the instant the dip began
    this.peakY = null;       // deepest signal reached during this dip
    this.dipStart = 0;
    this.cooldownUntil = 0;
    this.lastSignal = null;
    this.lastEyeShape = null;
    this.lastNosePitch = null;
    this.smoothY = null;
    this.lastSeenAt = null;
    this.stillFrames = 0;
    this.prevY = null;
    this.lastEyeDist = null;
    this.lastRollDeg = null;
  }

  /**
   * Feed one frame of face landmarks.
   *
   * @param {{noseTip: {x: number, y: number},
   *          leftEye: {x: number, y: number},
   *          rightEye: {x: number, y: number}}} points
   *        Landmark positions in normalised image coordinates. Landmark indices
   *        live in the caller; this file only knows about three points.
   * @param {number} nowMs Timestamp in milliseconds.
   * @param {number|null} [nosePitchDeg] Optional nose-pitch measurement from
   *        `nosePitchFromFacialTransformationMatrix`, positive down. When
   *        present, this is the signal; the eye-shape measurement is retained
   *        only as a fallback.
   * @returns {{triggered: boolean, state: string, debug: object}}
   */
  update(points, nowMs, nosePitchDeg = null) {
    const useNosePitch =
      typeof nosePitchDeg === 'number' && Number.isFinite(nosePitchDeg);
    const signalSource = useNosePitch ? 'nose-pitch' : 'eye-shape';

    // The two signals have incompatible units. Never carry smoothing, baseline,
    // or dip state across a source change. Likewise, a missing nose-pitch
    // frame after nose-pitch tracking has started is a tracking gap, not a
    // reason to substitute the fallback signal for one frame.
    if (useNosePitch && this.signalSource !== signalSource) {
      this.reset();
      this.signalSource = signalSource;
    } else if (!useNosePitch && this.signalSource === 'nose-pitch') {
      this.markFaceLost(nowMs);
      return this.#result(false, { aborted: 'nose-pitch-unavailable' });
    }

    // Thresholds follow the active signal because degrees and eye-distance
    // fractions are incompatible units.
    const thresholds = this.#thresholdsForSource(useNosePitch);
    this.activeThresholds = thresholds;

    const { noseTip, leftEye, rightEye } = points;
    const eyeMidX = (leftEye.x + rightEye.x) / 2;
    const eyeMidY = (leftEye.y + rightEye.y) / 2;

    // Interocular distance. The fallback signal uses it as its unit; the
    // nose-pitch signal does not, but the eye line still supplies the tilt
    // guard and useful debug context.
    const eyeDist = Math.hypot(leftEye.x - rightEye.x, leftEye.y - rightEye.y);
    if (!(eyeDist > 0)) {
      // Degenerate frame (face barely visible); treat as lost rather than
      // dividing by ~0 and producing an enormous bogus signal.
      this.markFaceLost(nowMs);
      return this.#result(false, { aborted: 'degenerate-eye-distance' });
    }

    // The face's own "down" axis: perpendicular to the line between the eyes.
    // (Image coordinates have +y pointing down, so rotating the eye vector
    // counter-clockwise in maths order points from the eyes toward the nose.)
    const eyeVecX = rightEye.x - leftEye.x;
    const eyeVecY = rightEye.y - leftEye.y;
    const downX = -eyeVecY / eyeDist;
    const downY = eyeVecX / eyeDist;

    // Fallback signal, signed so that a nod DOWN is a POSITIVE excursion.
    //
    // Pitching foreshortens the face, so the projected gap between the eyes and
    // the nose tip *shrinks* — the nose appears to rise toward the eye line.
    // Negating keeps the rest of this file readable, because everywhere below a
    // bigger value simply means "head further down".
    const eyeShapeSignal =
      -(
        (noseTip.x - eyeMidX) * downX +
        (noseTip.y - eyeMidY) * downY
      ) / eyeDist;
    const rawSignal = useNosePitch ? nosePitchDeg : eyeShapeSignal;

    // Light smoothing: keeps threshold crossings from flapping on noise.
    const signalAlpha = useNosePitch
      ? this.options.nosePitchSignalAlpha
      : this.options.signalAlpha;
    this.smoothY =
      this.smoothY === null
        ? rawSignal
        : this.smoothY + signalAlpha * (rawSignal - this.smoothY);

    const rollDeg = this.#rollDegrees(leftEye, rightEye);
    const lastSeen = this.lastSeenAt;
    this.lastSeenAt = nowMs;
    this.lastSignal = rawSignal;
    this.lastEyeShape = eyeShapeSignal;
    this.lastNosePitch = useNosePitch ? nosePitchDeg : null;
    this.lastEyeDist = eyeDist;
    this.lastRollDeg = rollDeg;

    // A face that disappeared partway through a dip leaves us unable to judge
    // whether the player came back up. Abandon the gesture instead of firing a
    // guess or blocking on the timeout.
    if (
      this.state === STATE_DIPPING &&
      lastSeen !== null &&
      nowMs - lastSeen > this.options.faceLostGraceMs
    ) {
      this.#abortDip(nowMs);
      return this.#result(false, { aborted: 'face-lost' });
    }

    const y = this.smoothY;

    if (this.state === STATE_COOLDOWN) {
      if (nowMs >= this.cooldownUntil) {
        this.state = STATE_IDLE;
      }
      return this.#result(false);
    }

    if (this.state === STATE_DISARMED) {
      return this.#rearm(y, nowMs, thresholds);
    }

    if (this.state === STATE_IDLE) {
      if (this.baseY === null) {
        this.baseY = y;
        return this.#result(false);
      }

      // Track the resting position so slow posture changes self-correct.
      // This runs ONLY in IDLE — that is the whole point.
      this.baseY += thresholds.baselineAlpha * (y - this.baseY);

      if (y - this.baseY > thresholds.enter) {
        this.state = STATE_DIPPING;
        this.dipRef = this.baseY; // freeze the reference for the whole dip
        this.peakY = y;
        this.dipStart = nowMs;
        return this.#result(false, { entered: true });
      }

      return this.#result(false);
    }

    // STATE_DIPPING
    if (y > this.peakY) {
      this.peakY = y;
    }

    const elapsed = nowMs - this.dipStart;

    // Too slow to be a nod: the player is looking at their instrument.
    if (elapsed > this.options.maxDurationMs) {
      this.#abortDip(nowMs);
      return this.#result(false, { aborted: 'too-slow' });
    }

    // Backstop for head tilt.
    if (Math.abs(rollDeg) > this.options.maxRollDeg) {
      this.#abortDip(nowMs);
      return this.#result(false, { aborted: 'head-tilt' });
    }

    const returnedUp = y < this.dipRef + thresholds.exit;
    const deepEnough = this.peakY - this.dipRef >= thresholds.minDepth;

    if (returnedUp && deepEnough) {
      // Re-seed from the current position: the head came back to roughly where
      // it started, so this is a safe resting estimate and keeps the baseline
      // from going stale between gestures.
      this.baseY = y;
      this.state = STATE_COOLDOWN;
      this.cooldownUntil = nowMs + this.options.cooldownMs;
      this.dipRef = null;
      this.peakY = null;
      return this.#result(true);
    }

    return this.#result(false);
  }

  /**
   * Tell the detector the face was not found this frame, so an in-flight dip
   * can be abandoned rather than left to time out.
   * @param {number} nowMs Timestamp in milliseconds.
   */
  markFaceLost(nowMs) {
    if (this.state === STATE_DIPPING) {
      this.#abortDip(nowMs);
    }
    this.lastSeenAt = nowMs;
  }

  /** Scale all gesture thresholds from the 1-10 sensitivity setting. */
  #sensitivityScale() {
    const numeric = Math.round(Number(this.options.sensitivity));
    const sensitivity = Number.isFinite(numeric)
      ? Math.min(MAX_SENSITIVITY, Math.max(MIN_SENSITIVITY, numeric))
      : DEFAULT_SENSITIVITY;
    return 1 - (sensitivity - DEFAULT_SENSITIVITY) * 0.08;
  }

  /** Thresholds for one signal source, with sensitivity applied. */
  #thresholdsForSource(useNosePitch) {
    // Sensitivity scales all three gesture thresholds together, preserving
    // the hysteresis relationship between them.
    const sensitivityScale = this.#sensitivityScale();
    if (useNosePitch) {
      return {
        enter: this.options.nosePitchEnterDeg * sensitivityScale,
        exit: this.options.nosePitchExitDeg * sensitivityScale,
        minDepth: this.options.nosePitchMinDepthDeg * sensitivityScale,
        baselineAlpha: this.options.nosePitchBaselineAlpha,
        stillTolerance: this.options.nosePitchStillDegPerFrame,
        unit: 'nose-pitch-deg',
      };
    }
    return {
      enter: this.options.enterThreshold * sensitivityScale,
      exit: this.options.exitThreshold * sensitivityScale,
      minDepth: this.options.minDepth * sensitivityScale,
      baselineAlpha: this.options.baselineAlpha,
      stillTolerance: this.options.stillTolerance,
      unit: 'eye-distance',
    };
  }

  /** Angle of the eye line in degrees; ~0 when level, larger when tilted. */
  #rollDegrees(leftEye, rightEye) {
    return (
      (Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x) * 180) /
      Math.PI
    );
  }

  /**
   * Give up on the current dip.
   *
   * The important part is where the baseline goes. Simply returning to IDLE
   * while the head is still down does not work: the frozen baseline is still up
   * at the player's true resting height, so the very next frame looks like a
   * brand new dip and the detector locks into an endless enter/abort loop after
   * one long look at the fretboard.
   *
   * So instead of adopting the held-down position as normal, we park the
   * baseline and wait. The player has to bring their head back up near where it
   * was before the dip began before detection resumes. That keeps the resting
   * estimate honest, and a genuine nod straight afterwards still registers.
   */
  #abortDip(nowMs) {
    this.state = STATE_DISARMED;
    this.dipRef = null;
    this.peakY = null;
    this.dipStart = nowMs;
  }

  /**
   * Wait out an aborted dip until the head returns to the pre-dip resting
   * position, then resume detection.
   */
  #rearm(y, nowMs, thresholds) {
    // Within exitThreshold of where the head sat before the aborted dip, so the
    // old baseline is valid again.
    if (y <= this.baseY + thresholds.exit) {
      this.state = STATE_IDLE;
      return this.#result(false, { rearmed: true });
    }

    // Safety valve: if the player settles into a new, permanently different
    // posture (leaning in, sitting differently) the old baseline would never be
    // reached again and detection would stay off forever. So if the head has
    // been steady for long enough, accept where it now is as the new normal.
    //
    // "Steady" is a rate threshold, not equality. Real landmarks jitter every
    // frame, so requiring the signal to be bit-identical would never be
    // satisfied and the detector would stay disarmed for good.
    if (this.prevY !== null && Math.abs(y - this.prevY) < thresholds.stillTolerance) {
      this.stillFrames += 1;
    } else {
      this.stillFrames = 0;
    }
    this.prevY = y;

    if (this.stillFrames * FRAME_INTERVAL_MS >= this.options.rearmStillMs) {
      this.baseY = y;
      this.stillFrames = 0;
      this.state = STATE_IDLE;
      return this.#result(false, { rearmed: 'posture-change' });
    }

    return this.#result(false);
  }

  #result(triggered, extra = {}) {
    return {
      triggered,
      state: this.state,
      debug: {
        signalSource: this.signalSource,
        signalUnit: this.activeThresholds ? this.activeThresholds.unit : null,
        thresholds: this.activeThresholds,
        // Active signal: nose pitch in degrees, or fallback eye shape in
        // eye-distance units.
        rawSignal: this.lastSignal,
        nosePitchDeg: this.lastNosePitch,
        eyeShape: this.lastEyeShape,
        smoothY: this.smoothY,
        baseY: this.baseY,
        dipRef: this.dipRef,
        peakY: this.peakY,
        depth:
          this.peakY !== null && this.dipRef !== null
            ? this.peakY - this.dipRef
            : null,
        // Raw landmark context, useful when tuning against a live camera.
        eyeDist: this.lastEyeDist,
        rollDeg: this.lastRollDeg,
        options: this.options,
        ...extra,
      },
    };
  }
}

NodDetector.CALIBRATION_TARGET_SAMPLES = CALIBRATION_TARGET_SAMPLES;

// Exposed as a global for the extension page, mirroring how vision_bundle.js
// publishes MediaPipe. Tests read it back off globalThis.
if (typeof globalThis !== 'undefined') {
  globalThis.NodDetector = NodDetector;
  globalThis.NOD_DETECTOR_STATES = {
    IDLE: STATE_IDLE,
    DIPPING: STATE_DIPPING,
    COOLDOWN: STATE_COOLDOWN,
    DISARMED: STATE_DISARMED,
  };
}
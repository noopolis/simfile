import { useEffect, useMemo, useRef, useState } from "react";

import type { ViewerSpatialSample } from "./types.js";
import {
  publishPlaybackDiagnostics,
  recordPlaybackDiagnostics,
  type PlaybackDiagnosticsSnapshot,
  type PlaybackProbe,
} from "./playbackDiagnostics.js";
import {
  advanceLiveSpatialPlayback,
  createLiveSpatialPlaybackState,
  createSpatialPlaybackAnimationClock,
  createSpatialPlaybackState,
  reconcileLiveSpatialPlayback,
  reconcileSpatialPlaybackSamples,
  scrubSpatialPlayback,
  setSpatialPlaybackPlaying,
  spatialPlaybackSpeeds,
  stepSpatialPlaybackAnimationClock,
  type SpatialPlaybackAnimationClock,
  type SpatialPlaybackSpeed,
  type SpatialPlaybackState,
} from "./spatialPlayback.js";

interface SpatialPlaybackControlsProps {
  live?: boolean;
  onTick: (tick: number) => void;
  runId: string;
  samples: readonly ViewerSpatialSample[];
  tickDurationMs: number;
}

const liveIdleDrainMs = 3_000;

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined"
  && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

export function SpatialPlaybackControls({
  live = false,
  onTick,
  runId,
  samples,
  tickDurationMs,
}: SpatialPlaybackControlsProps) {
  const reducedMotion = useMemo(prefersReducedMotion, []);
  const [playback, setPlayback] = useState<SpatialPlaybackState>(
    () => createSpatialPlaybackState(samples),
  );
  const [speed, setSpeed] = useState<SpatialPlaybackSpeed>(1);
  const [manualReplay, setManualReplay] = useState(false);
  const [manualPlayRequested, setManualPlayRequested] = useState(false);
  const [liveDrain, setLiveDrain] = useState(false);
  const [diagnostics, setDiagnostics] =
    useState<PlaybackDiagnosticsSnapshot | null>(null);
  const initializedRun = useRef("");
  const frontierTick = samples.at(-1)?.tick ?? 0;
  const animation = useRef<number | null>(null);
  const animationClock = useRef<SpatialPlaybackAnimationClock>(
    createSpatialPlaybackAnimationClock(),
  );
  const playbackRef = useRef(playback);
  const probeRef = useRef<PlaybackProbe | null>(null);
  const samplesRef = useRef(samples);
  const followingLive = live && !manualReplay;

  useEffect(() => {
    playbackRef.current = playback;
  }, [playback]);

  useEffect(() => {
    samplesRef.current = samples;
    const runKey = `${runId}:${live ? "live" : "replay"}`;
    if (initializedRun.current !== runKey) {
      initializedRun.current = runKey;
      setManualReplay(false);
      setManualPlayRequested(!live && !reducedMotion);
      setLiveDrain(false);
      setPlayback(live
        ? createLiveSpatialPlaybackState(samples, tickDurationMs, reducedMotion)
        : createSpatialPlaybackState(samples, !reducedMotion));
      return;
    }
    setPlayback((current) => {
      if (followingLive) {
        return reconcileLiveSpatialPlayback(
          current,
          samples,
          tickDurationMs,
          reducedMotion,
        );
      }
      return reconcileSpatialPlaybackSamples(
        current,
        samples,
        manualPlayRequested && !reducedMotion,
      );
    });
  }, [
    followingLive,
    frontierTick,
    live,
    manualPlayRequested,
    reducedMotion,
    runId,
    samples,
    tickDurationMs,
  ]);

  useEffect(() => {
    if (!followingLive || samples.length < 2) {
      setLiveDrain(false);
      return;
    }
    setLiveDrain(false);
    const timer = window.setTimeout(() => {
      setLiveDrain(true);
      setPlayback((current) => current.playing
        ? current
        : { ...current, ended: false, playing: true });
    }, liveIdleDrainMs);
    return () => window.clearTimeout(timer);
  }, [followingLive, frontierTick, runId, samples.length]);

  useEffect(() => {
    onTick(playback.tick);
  }, [onTick, playback.tick]);

  useEffect(() => {
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    animation.current = null;
    animationClock.current = createSpatialPlaybackAnimationClock();
    probeRef.current = null;
    setDiagnostics(null);
    if (!playback.playing || samples.length < 2) return;
    const step = (now: number) => {
      const current = playbackRef.current;
      const priorTimestampMs = animationClock.current.priorTimestampMs;
      let next: SpatialPlaybackState;
      let elapsedMs: number;
      if (followingLive) {
        elapsedMs = priorTimestampMs === null ? 0 : Math.max(0, now - priorTimestampMs);
        animationClock.current = Object.freeze({
          anchorTick: null,
          priorTimestampMs: now,
          startedAtMs: null,
        });
        next = advanceLiveSpatialPlayback(
          current,
          samplesRef.current,
          elapsedMs,
          tickDurationMs,
          liveDrain,
        );
      } else {
        const stepped = stepSpatialPlaybackAnimationClock(
          animationClock.current,
          current,
          samplesRef.current,
          now,
          tickDurationMs,
          speed,
        );
        animationClock.current = stepped.clock;
        elapsedMs = stepped.elapsedMs;
        next = stepped.playback;
      }
      playbackRef.current = next;
      setPlayback(next);
      const published = recordPlaybackDiagnostics(
        probeRef,
        current,
        next,
        now,
        elapsedMs,
        tickDurationMs,
        followingLive ? 1 : speed,
      );
      if (published) {
        setDiagnostics(published);
        publishPlaybackDiagnostics();
      }
      animation.current = requestAnimationFrame(step);
    };
    animation.current = requestAnimationFrame(step);
    return () => {
      if (animation.current !== null) cancelAnimationFrame(animation.current);
      animation.current = null;
      animationClock.current = createSpatialPlaybackAnimationClock();
      probeRef.current = null;
    };
  }, [followingLive, liveDrain, playback.playing, speed, tickDurationMs]);

  if (samples.length === 0) return null;

  const replay = () => {
    setManualReplay(live);
    setManualPlayRequested(!reducedMotion);
    setLiveDrain(false);
    setPlayback(createSpatialPlaybackState(samples, !reducedMotion));
  };
  const goLive = () => {
    setManualReplay(false);
    setManualPlayRequested(false);
    setLiveDrain(false);
    setPlayback(
      createLiveSpatialPlaybackState(samples, tickDurationMs, reducedMotion),
    );
  };
  const toggle = () => {
    const playing = !(playback.playing || live && manualPlayRequested)
      && !reducedMotion;
    setManualPlayRequested(playing);
    setPlayback((current) =>
      setSpatialPlaybackPlaying(current, samples, playing));
  };
  const elapsedSeconds = Math.max(
    0,
    (playback.tick - (samples[0]?.tick ?? 0)) * tickDurationMs / 1_000,
  );

  return (
    <section className="spatial-playback" aria-label="Spatial replay controls">
      <div className="spatial-playback-buttons">
        <button onClick={replay} type="button">↺ Replay</button>
        {live ? (
          <button
            aria-label="Follow buffered live frontier"
            className={followingLive ? "active" : ""}
            disabled={followingLive}
            onClick={goLive}
            type="button"
          >
            ● Live
          </button>
        ) : null}
        {!followingLive ? (
          <button
            aria-label={playback.playing || live && manualPlayRequested
              ? "Pause spatial replay"
              : "Play spatial replay"}
            className={playback.playing || live && manualPlayRequested ? "active" : ""}
            disabled={reducedMotion || samples.length < 2}
            onClick={toggle}
            type="button"
          >
            {playback.playing || live && manualPlayRequested
              ? "❚❚ Pause"
              : "▶ Play"}
          </button>
        ) : null}
      </div>
      <input
        aria-label="Spatial replay frame"
        max={Math.max(0, samples.length - 1)}
        min={0}
        onChange={(event) => {
          setManualReplay(live);
          setManualPlayRequested(false);
          setPlayback(scrubSpatialPlayback(samples, Number(event.target.value)));
        }}
        step={1}
        type="range"
        value={playback.frame}
      />
      <label>
        <span>speed</span>
        <select
          aria-label="Spatial replay speed"
          disabled={followingLive}
          onChange={(event) => setSpeed(Number(event.target.value) as SpatialPlaybackSpeed)}
          value={speed}
        >
          {spatialPlaybackSpeeds.map((option) => (
            <option key={option} value={option}>{option}x</option>
          ))}
        </select>
      </label>
      <output>
        frame {playback.frame + 1}/{samples.length} · tick {playback.tick.toFixed(1)}
        {" · "}{elapsedSeconds.toFixed(1)}s
        {followingLive ? liveDrain ? " · live drain" : " · buffered live" : ""}
        {diagnostics ? (
          <>
            {" · clock "}{diagnostics.observedSpeed.toFixed(2)}x
            {" · "}{diagnostics.callbackFps.toFixed(0)} fps
            {" · pos "}{diagnostics.positionFps.toFixed(0)} fps
            {" · dyn "}{diagnostics.dynamicRasterP95Ms.toFixed(1)}ms p95
            {" · gaps>100 "}{diagnostics.gapsOver100Ms}
          </>
        ) : null}
      </output>
    </section>
  );
}

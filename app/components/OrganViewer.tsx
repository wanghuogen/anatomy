"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Box,
  CircleDashed,
  Layers3,
  Maximize2,
  RotateCcw,
  ScanLine,
  Search,
  Check,
  Crosshair,
  Eye,
  EyeOff,
  Focus,
  Sparkles,
  X,
} from "lucide-react";
import type { Hotspot, Organ } from "../i18n/merge";
import { format, type UiDictionary } from "../i18n/types";
import type { AnatomyViewer } from "../lib/three/viewer";
import type { ClinicalHeartState } from "./ClinicalEducation";

type Props = {
  organ: Organ;
  t: UiDictionary;
  autoRotate: boolean;
  onAutoRotate: (enabled: boolean) => void;
  compare: boolean;
  onCompare: () => void;
  quizActive: boolean;
  onQuizExit: () => void;
  onNotice: (message: string) => void;
  locale: string;
  clinicalState?: ClinicalHeartState | null;
};

const STRUCTURE_COLORS = {
  chambers: "#cf7775",
  valves: "#d7a34c",
  papillary: "#8f6b91",
} as const;

/** Fisher–Yates. The quiz asks for every structure once, in a fresh order. */
function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

type PickRef = { current: (hotspot: Hotspot) => void };

/**
 * The labelling quiz. Owns its own round state and is mounted with a `key` per
 * organ, so switching specimens restarts it without a resetting effect.
 */
function LabelQuiz({
  hotspots, t, pickRef, flash, screenY, onExit,
}: {
  hotspots: Hotspot[];
  t: UiDictionary;
  pickRef: PickRef;
  flash: (id: string, correct: boolean) => void;
  screenY: (id: string) => number | null;
  onExit: () => void;
}) {
  const [seed, setSeed] = useState(0);
  const [step, setStep] = useState(0);
  const [score, setScore] = useState(0);
  const [answer, setAnswer] = useState<{ correct: boolean; picked: string; target: string; atTop: boolean } | null>(null);
  const [results, setResults] = useState<boolean[]>([]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const order = useMemo(() => shuffle(hotspots), [hotspots, seed]);
  const target = order[step];
  const finished = step >= order.length;

  // Refreshed after every render so the viewer's long-lived callback always
  // sees the current question. Writing a ref in an effect is safe; writing one
  // during render is not.
  useEffect(() => {
    pickRef.current = (hotspot) => {
      if (!target || answer) return;   // ignore extra clicks while feedback shows
      const correct = hotspot.id === target.id;
      flash(hotspot.id, correct);
      // A miss also marks where the answer actually was — otherwise the learner
      // is told they were wrong but never shown the right structure.
      if (!correct) flash(target.id, true);
      // Sit the card on the opposite half from the structure being revealed —
      // otherwise the panel hides the dot it is telling the learner to look at.
      const revealed = screenY(correct ? hotspot.id : target.id);
      setAnswer({ correct, picked: hotspot.label, target: target.label, atTop: (revealed ?? 0) > 0.55 });
      setResults((list) => [...list, correct]);
      if (correct) setScore((value) => value + 1);
      window.setTimeout(() => {
        setAnswer(null);
        setStep((value) => value + 1);
      }, correct ? 1200 : 2400);   // a miss carries more to read
    };
  });

  const retry = () => {
    setStep(0);
    setScore(0);
    setAnswer(null);
    setResults([]);
    setSeed((value) => value + 1);
  };

  return (
    <>
      {target && (
        <div className="quiz-bar" role="status" aria-live="polite">
          <div className="quiz-prompt">
            <em>{t.quiz.find}</em>
            <strong>{target.label}</strong>
          </div>
          <div className="quiz-meta">
            <span className="quiz-progress">{format(t.quiz.progress, { current: String(step + 1), total: String(order.length) })}</span>
            <ol className="quiz-pips" aria-hidden>
              {order.map((hotspot, index) => (
                <li
                  key={hotspot.id}
                  className={index < results.length ? (results[index] ? "ok" : "no") : index === step ? "now" : ""}
                />
              ))}
            </ol>
            <small>{t.quiz.hint}</small>
          </div>
          <button type="button" onClick={onExit} aria-label={t.quiz.exit}><X size={16} /></button>
        </div>
      )}

      {answer && (
        <div className={`quiz-answer ${answer.correct ? "ok" : "no"} ${answer.atTop ? "at-top" : ""}`} role="status" aria-live="assertive">
          <span className="quiz-answer-icon">{answer.correct ? <Check size={22} /> : <X size={22} />}</span>
          <div>
            <strong>{answer.correct ? t.quiz.correct : t.quiz.wrong}</strong>
            {answer.correct ? (
              <span>{answer.target}</span>
            ) : (
              <>
                <span>{format(t.quiz.reveal, { label: answer.picked })}</span>
                <span className="quiz-answer-hint">{format(t.quiz.answer, { label: answer.target })}</span>
              </>
            )}
          </div>
        </div>
      )}

      {finished && (
        <div className="quiz-summary" role="dialog" aria-modal="true">
          <span className="modal-icon">{score === order.length ? "★" : "✓"}</span>
          <h2>{t.quiz.done}</h2>
          <p>{format(t.quiz.score, { score: String(score), total: String(order.length) })}</p>
          <div className="quiz-summary-actions">
            <button type="button" className="lesson-button" onClick={retry}>{t.quiz.retry}</button>
            <button type="button" onClick={onExit}>{t.quiz.exit}</button>
          </div>
        </div>
      )}
    </>
  );
}

/** `?authoring=1` is read from the URL without a hydration mismatch. */
function useAuthoringFlag() {
  return useSyncExternalStore(
    () => () => {},
    () => new URLSearchParams(window.location.search).get("authoring") === "1",
    () => false,
  );
}

export function OrganViewer({ organ, t, autoRotate, onAutoRotate, compare, onCompare, quizActive, onQuizExit, onNotice, locale, clinicalState }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<AnatomyViewer | null>(null);
  const organRef = useRef(organ);
  const autoRotateRef = useRef(autoRotate);
  const canvasLabelRef = useRef(t.viewer.canvas);
  const [selected, setSelected] = useState<Hotspot | null>(null);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  const [slowLoad, setSlowLoad] = useState(false);
  const [activeTools, setActiveTools] = useState<string[]>([]);
  const [viewChoice, setViewChoice] = useState<{ organId: string; mode: "external" | "internal" }>({ organId: organ.id, mode: "external" });
  const [structureVisibility, setStructureVisibility] = useState<Record<string, boolean>>({});
  const internalView = organ.internalView;
  const internalMode = Boolean(internalView && (clinicalState || (viewChoice.organId === organ.id && viewChoice.mode === "internal")) && !quizActive);
  const copy = locale === "zh" ? {
    external: "外部结构", internal: "内部结构", panel: "心脏内部", cutaway: "透明剖面", showAll: "完整显示",
    chambers: "心腔与间隔", valves: "心脏瓣膜", papillary: "乳头肌", isolate: "单独显示", source: "模型来源",
  } : {
    external: "External", internal: "Internal", panel: "Inside the heart", cutaway: "Teaching cutaway", showAll: "Show all",
    chambers: "Chambers & septum", valves: "Heart valves", papillary: "Papillary muscles", isolate: "Isolate", source: "Model source",
  };

  // Opt-in coordinate probe for placing hotspots — not a user-facing feature.
  const authoring = useAuthoringFlag();
  const authoringRef = useRef(authoring);
  const [authorPoint, setAuthorPoint] = useState<{ x: number; y: number; z: number } | null>(null);
  const [copied, setCopied] = useState(false);

  // The viewer captures its callbacks once, so live handlers go through refs.
  const pickRef = useRef<(hotspot: Hotspot) => void>(() => {});
  const authorRef = useRef<(point: { x: number; y: number; z: number }) => void>(() => {});
  useEffect(() => {
    authorRef.current = setAuthorPoint;
  }, []);
  useEffect(() => {
    authoringRef.current = authoring;
  }, [authoring]);

  // A typical organ is ready well inside a second — flashing a loading panel for
  // that reads as jank. It only appears if the fetch is genuinely slow; the flag
  // is cleared by onLoading when the next load starts.
  useEffect(() => {
    if (!loading) return;
    const timer = window.setTimeout(() => setSlowLoad(true), 900);
    return () => window.clearTimeout(timer);
  }, [loading]);

  useEffect(() => {
    organRef.current = organ;
  }, [organ]);

  useEffect(() => {
    autoRotateRef.current = autoRotate;
  }, [autoRotate]);

  useEffect(() => {
    canvasLabelRef.current = t.viewer.canvas;
    viewerRef.current?.setCanvasLabel(t.viewer.canvas);
  }, [t.viewer.canvas]);

  useEffect(() => {
    let cancelled = false;
    let viewer: AnatomyViewer | null = null;

    void import("../lib/three/viewer").then(({ AnatomyViewer: Viewer }) => {
      if (cancelled || !mountRef.current) return;
      viewer = new Viewer(mountRef.current, {
        onSelect: setSelected,
        onLoading: (isLoading, value) => {
          setLoading(isLoading);
          setProgress(value);
          if (isLoading) setSlowLoad(false);
        },
        onPick: (hotspot) => pickRef.current(hotspot),
        onAuthorPoint: (point) => authorRef.current(point),
      });
      viewerRef.current = viewer;
      viewer.setCanvasLabel(canvasLabelRef.current);
      viewer.setAutoRotate(autoRotateRef.current);
      viewer.setAuthoring(authoringRef.current);
      const current = organRef.current;
      viewer.setOrgan(current.model, current.hotspots, current.accent).catch(() => {
        setLoading(false);
        setProgress(0);
      });
    });

    return () => {
      cancelled = true;
      viewerRef.current = null;
      viewer?.dispose();
    };
  }, []);

  useEffect(() => {
    const internal = internalMode ? internalView : undefined;
    const model = internal?.model ?? organ.model;
    const hotspots = internal ? [] : organ.hotspots;
    viewerRef.current?.setOrgan(model, hotspots, organ.accent).then(() => {
      setActiveTools([]);
      if (!internal) {
        viewerRef.current?.setPresentation(8.2, 0);
        return;
      }
      const visibility = Object.fromEntries(internal.structures.map((structure) => [structure.id, true]));
      viewerRef.current?.colorStructures(internal.structures.map((structure) => ({
        nodeName: structure.nodeName,
        color: structure.id === "septum" ? "#e4c5a4" : STRUCTURE_COLORS[structure.group],
      })));
      internal.structures.forEach((structure) => {
        viewerRef.current?.setStructureVisible(structure.nodeName, true);
        viewerRef.current?.setStructureOpacity(structure.nodeName, structure.group === "chambers" ? (structure.id === "septum" ? 0.62 : 0.16) : 1);
      });
      if (clinicalState) {
        const mitral = internal.structures.find((structure) => structure.id === "mitral-valve");
        if (mitral) {
          viewerRef.current?.colorStructures([{ nodeName: mitral.nodeName, color: clinicalState === "disease" ? "#d9534f" : clinicalState === "postop" ? "#47a66c" : "#d7a34c" }]);
          viewerRef.current?.setStructureOpacity(mitral.nodeName, 1);
        }
      }
      viewerRef.current?.setPresentation(6.2, -0.65);
      setStructureVisibility(visibility);
    }).catch(() => {
      setLoading(false);
      setProgress(0);
    });
  }, [organ, internalMode, internalView, clinicalState]);

  // A spinning specimen makes "click the mitral valve" a game of chance, so the
  // quiz holds the model still and restores the user's setting on exit.
  useEffect(() => viewerRef.current?.setAutoRotate(autoRotate && !quizActive), [autoRotate, quizActive]);
  useEffect(() => viewerRef.current?.setQuizMode(quizActive), [quizActive]);
  useEffect(() => viewerRef.current?.setAuthoring(authoring), [authoring]);


  // The viewer drives the callout's position directly, so a spinning model
  // never costs a React render.
  const calloutRef = useCallback((node: HTMLDivElement | null) => {
    viewerRef.current?.attachCallout(node);
  }, []);

  const handleTool = (tool: string) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const setTool = (enabled: boolean) => {
      setActiveTools((current) => enabled
        ? (current.includes(tool) ? current : [...current, tool])
        : current.filter((item) => item !== tool));
    };
    if (tool === "rotate") {
      onAutoRotate(!autoRotate);
      onNotice(t.tools.rotate);
    }
    if (tool === "zoom") {
      setTool(viewer.toggleZoom());
      onNotice(t.tools.zoom);
    }
    if (tool === "isolate") {
      setTool(viewer.toggleIsolate());
      onNotice(t.tools.isolate);
    }
    if (tool === "section") {
      setTool(viewer.toggleCrossSection());
      onNotice(t.tools.section);
    }
    if (tool === "layers") {
      setTool(viewer.toggleLayers());
      onNotice(t.tools.layers);
    }
    if (tool === "compare") {
      onCompare();
      onNotice(t.tools.compare);
    }
    if (tool === "reset") {
      viewer.reset();
      if (internalMode && internalView) {
        const visibility = Object.fromEntries(internalView.structures.map((structure) => [structure.id, true]));
        internalView.structures.forEach((structure) => {
          viewer.setStructureVisible(structure.nodeName, true);
          viewer.setStructureOpacity(structure.nodeName, structure.group === "chambers" ? (structure.id === "septum" ? 0.62 : 0.16) : 1);
        });
        viewer.setPresentation(6.2, -0.65);
        setStructureVisibility(visibility);
      }
      setActiveTools([]);
      onNotice(t.tools.reset);
    }
  };

  const tools = [
    { id: "rotate", label: t.tools.rotate, icon: RotateCcw },
    { id: "zoom", label: t.tools.zoom, icon: Search },
    { id: "isolate", label: t.tools.isolate, icon: CircleDashed },
    { id: "section", label: t.tools.section, icon: ScanLine },
    { id: "layers", label: t.tools.layers, icon: Layers3 },
    { id: "compare", label: t.tools.compare, icon: Box },
    { id: "reset", label: t.tools.reset, icon: RotateCcw },
  ].filter(({ id }) => !internalMode || !["isolate", "section", "layers"].includes(id));

  const setStructures = (ids: string[], visible: boolean) => {
    if (!internalView) return;
    const wanted = new Set(ids);
    viewerRef.current?.setStructuresVisible(
      internalView.structures.filter((structure) => wanted.has(structure.id)).map((structure) => structure.nodeName),
      visible,
    );
    setStructureVisibility((current) => ({ ...current, ...Object.fromEntries(ids.map((id) => [id, visible])) }));
  };

  const applyCutaway = () => {
    if (!internalView) return;
    const visibility = Object.fromEntries(internalView.structures.map((structure) => [structure.id, true]));
    internalView.structures.forEach((structure) => {
      viewerRef.current?.setStructureVisible(structure.nodeName, true);
      viewerRef.current?.setStructureOpacity(structure.nodeName, structure.group === "chambers" ? (structure.id === "septum" ? 0.62 : 0.16) : 1);
    });
    viewerRef.current?.setPresentation(6.2, -0.65);
    setStructureVisibility(visibility);
  };

  const showAllInternal = () => {
    if (!internalView) return;
    internalView.structures.forEach((structure) => {
      viewerRef.current?.setStructureVisible(structure.nodeName, true);
      viewerRef.current?.setStructureOpacity(structure.nodeName, 1);
    });
    setStructureVisibility(Object.fromEntries(internalView.structures.map((structure) => [structure.id, true])));
  };

  const groups = internalView ? Array.from(new Set(internalView.structures.map((structure) => structure.group))) : [];

  return (
    <section id="organ-viewer" className="viewer-shell" aria-label={format(t.viewer.title, { organ: organ.name })}>
      <div className="viewer-glow" style={{ "--organ-accent": organ.accent } as React.CSSProperties} />
      <div ref={mountRef} className="three-mount" />

      {internalView && !quizActive && (
        <div className="view-mode-switch" aria-label={copy.panel}>
          <button type="button" className={!internalMode ? "active" : ""} onClick={() => setViewChoice({ organId: organ.id, mode: "external" })}>{copy.external}</button>
          <button type="button" className={internalMode ? "active" : ""} onClick={() => setViewChoice({ organId: organ.id, mode: "internal" })}>{copy.internal}</button>
        </div>
      )}

      <div className="viewer-tools" aria-label={t.tools.label}>
        {tools.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={`tool-button ${(activeTools.includes(id) || (id === "rotate" && autoRotate) || (id === "compare" && compare)) ? "active" : ""}`}
            onClick={() => handleTool(id)}
            aria-pressed={activeTools.includes(id) || (id === "rotate" && autoRotate) || (id === "compare" && compare)}
            title={label}
          >
            <Icon size={19} strokeWidth={1.65} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {internalMode && internalView && (
        <aside className="internal-structures" aria-label={copy.panel}>
          <header><strong>{copy.panel}</strong><small>{internalView.structures.length}</small></header>
          <div className="internal-presets">
            <button type="button" onClick={applyCutaway}>{copy.cutaway}</button>
            <button type="button" onClick={showAllInternal}>{copy.showAll}</button>
          </div>
          <div className="internal-structure-list">
            {groups.map((group) => {
              const items = internalView.structures.filter((structure) => structure.group === group);
              return (
                <section key={group}>
                  <h3>{copy[group]}</h3>
                  {items.map((structure) => {
                    const visible = structureVisibility[structure.id] !== false;
                    return (
                      <div className="internal-structure-row" key={structure.id} style={{ "--structure-color": structure.id === "septum" ? "#e4c5a4" : STRUCTURE_COLORS[structure.group] } as React.CSSProperties}>
                        <button type="button" className={visible ? "visible" : ""} onClick={() => setStructures([structure.id], !visible)} aria-pressed={visible}>
                          {visible ? <Eye size={13} /> : <EyeOff size={13} />}
                          <span><b>{structure.label[locale === "zh" ? "zh" : "en"]}</b><small>{structure.ontologyId}</small></span>
                        </button>
                        <button type="button" title={copy.isolate} aria-label={`${copy.isolate}: ${structure.label[locale === "zh" ? "zh" : "en"]}`} onClick={() => {
                          viewerRef.current?.isolateStructure(structure.nodeName);
                          setStructureVisibility(Object.fromEntries(internalView.structures.map((item) => [item.id, item.id === structure.id])));
                        }}><Focus size={13} /></button>
                      </div>
                    );
                  })}
                </section>
              );
            })}
          </div>
          <footer><span>{copy.source}</span><a href={internalView.sourceUrl} target="_blank" rel="noreferrer">{internalView.sourceName} · {internalView.sourceVersion}</a><a href={internalView.licenseUrl} target="_blank" rel="noreferrer">{internalView.license}</a></footer>
        </aside>
      )}

      {!quizActive && !internalMode && (
      <aside className="tip-note" aria-label={t.viewer.tip}>
        <span><Sparkles size={15} /> {t.viewer.tip}</span>
        <p>{t.viewer.tipDrag}<br />{t.viewer.tipScroll}<br />{t.viewer.tipClick}</p>
      </aside>
      )}

      {selected && !quizActive && (
        <div className="hotspot-callout" ref={calloutRef} data-side="right">
          <div className="callout-body" style={{ "--hotspot-color": selected.color } as React.CSSProperties}>
            <button className="callout-close" type="button" onClick={() => viewerRef.current?.clearSelection()} aria-label={t.modal.close}>
              <X size={13} />
            </button>
            <b>{selected.label}</b>
            <small>{selected.detail}</small>
          </div>
        </div>
      )}

      {/* Screen-reader equivalent of the dots, which live in the canvas. */}
      <ul className="hotspot-index" aria-label={t.viewer.structures}>
        {organ.hotspots.map((hotspot) => (
          <li key={hotspot.id}>{hotspot.label}: {hotspot.detail}</li>
        ))}
      </ul>

      {quizActive && (
        <LabelQuiz
          key={organ.id}
          hotspots={organ.hotspots}
          t={t}
          pickRef={pickRef}
          flash={(id, correct) => viewerRef.current?.flash(id, correct)}
          screenY={(id) => viewerRef.current?.hotspotScreenY(id) ?? null}
          onExit={onQuizExit}
        />
      )}

      {authoring && (
        <div className="authoring-panel">
          <span><Crosshair size={13} /> authoring</span>
          {authorPoint ? (
            <>
              <code>{`{ id: "", ta: "", position: [${authorPoint.x}, ${authorPoint.y}, ${authorPoint.z}], color: "#ee7c6a" },`}</code>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(`{ id: "", ta: "", position: [${authorPoint.x}, ${authorPoint.y}, ${authorPoint.z}], color: "#ee7c6a" },`)
                    .then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200); });
                }}
              >
                {copied ? "copied" : "copy"}
              </button>
            </>
          ) : (
            <code>click the model to sample a point</code>
          )}
        </div>
      )}

      {loading && slowLoad && (
        <div className="model-loader" role="status" aria-live="polite">
          <div className="loader-orbit"><Maximize2 size={20} /></div>
          <strong>{format(t.viewer.loading, { organ: organ.name })}</strong>
          <span>{Math.max(8, Math.round(progress * 100))}%</span>
        </div>
      )}

      {!quizActive && (
      <button className="auto-rotate" type="button" onClick={() => onAutoRotate(!autoRotate)} aria-pressed={autoRotate}>
        <RotateCcw size={14} /> {t.viewer.autoRotate}
        <span className={`switch ${autoRotate ? "on" : ""}`}><i /></span>
      </button>
      )}

      <div className="view-caption">
        <span>{t.viewer.caption}</span>
        <strong>{organ.scientificName}</strong>
      </div>
    </section>
  );
}

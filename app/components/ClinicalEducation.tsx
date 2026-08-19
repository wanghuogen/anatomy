"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ClipboardCheck,
  HeartPulse,
  Pause,
  Play,
  ShieldAlert,
  Stethoscope,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { organStructures } from "../lib/anatomy-data";
import { AnatomyViewer } from "../lib/three/viewer";

export type ClinicalHeartState = "normal" | "disease" | "postop";

type Props = {
  locale: string;
  modelState: ClinicalHeartState;
  onModelState: (state: ClinicalHeartState) => void;
  onClose: () => void;
};

const content = {
  zh: {
    eyebrow: "围手术期宣教样板",
    title: "二尖瓣修复术",
    subtitle: "用同一个心脏模型解释正常结构、瓣膜病变与术后预期",
    doctor: "医生讲解",
    patient: "患者阅读",
    privacy: "演示模式 · 不保存患者身份或病历信息",
    close: "关闭宣教",
    stages: [
      { id: "normal", label: "正常", title: "正常二尖瓣", body: "二尖瓣位于左心房与左心室之间，开放时让血液进入左心室，关闭时防止血液倒流。", cue: "在模型中找到左心房、左心室和二尖瓣。" },
      { id: "disease", label: "病变", title: "二尖瓣关闭不全", body: "瓣叶不能完全闭合时，部分血液会在心脏收缩时反流回左心房，可能引起气促、乏力或心脏扩大。", cue: "红色高亮表示本次重点讲解的瓣膜位置。" },
      { id: "postop", label: "术后预期", title: "修复后的瓣膜", body: "手术会根据具体情况修复瓣叶、腱索，并可能植入成形环，目标是减少反流并尽量保留自身瓣膜。", cue: "绿色代表修复目标，不代表对个体疗效的保证。" },
    ],
    tabs: ["术前路径", "术后恢复", "理解确认"],
    preop: [
      { title: "认识病变", body: "确认病变瓣膜、反流方向以及它对心脏功能的影响。" },
      { title: "了解手术", body: "医生会根据检查结果决定修复方式；术中发现可能影响最终方案。" },
      { title: "比较选择", body: "讨论修复、置换或继续观察等选择，以及各自的获益、风险与限制。" },
      { title: "术前准备", body: "按照医护要求完成检查、药物调整、禁食禁饮和皮肤准备。" },
      { title: "术后去向", body: "通常先进入监护区域，待循环和呼吸稳定后转回普通病房。" },
    ],
    recoveryTitle: "恢复清单",
    recoveryNote: "以下是通用宣教示例，实际安排以主管医护团队要求为准。",
    recovery: ["按指导进行深呼吸、有效咳嗽和早期活动", "保持伤口清洁，观察红肿、渗液或裂开", "按医嘱服药，不自行停用抗凝或心血管药物", "记录体温、体重以及气促或水肿变化", "按预约复诊并携带出院记录和用药清单"],
    warningTitle: "需要尽快联系医护团队",
    warnings: ["胸痛、明显气促或意识变化", "持续高热、伤口渗液或出血", "心悸伴头晕、晕厥", "体重短期快速增加或下肢水肿加重"],
    teachTitle: "请患者用自己的话说明",
    teachIntro: "这不是考患者，而是帮助医护人员确认解释是否清楚。",
    questions: ["这次手术计划修复心脏的哪个部位？", "出院后哪些异常情况需要尽快联系医院？", "药物和活动安排不确定时，你准备怎么处理？"],
    understood: "已理解",
    revisit: "需要再解释",
    summary: "宣教进度",
    complete: "完成本次宣教",
    completed: "已完成，可由医生再次核对重点",
    previous: "上一步",
    next: "下一步",
    disclaimer: "本页面用于辅助沟通，不替代医生诊断、个体化治疗建议或正式知情同意。",
  },
  en: {
    eyebrow: "Perioperative education sample",
    title: "Mitral valve repair",
    subtitle: "Explain normal anatomy, valve disease, and the expected repair with one heart model",
    doctor: "Clinician view", patient: "Patient view", privacy: "Demo mode · no patient identity or medical record is stored", close: "Close education",
    stages: [
      { id: "normal", label: "Normal", title: "Normal mitral valve", body: "The mitral valve sits between the left atrium and ventricle. It opens for forward flow and closes to prevent backward flow.", cue: "Locate the left atrium, left ventricle, and mitral valve." },
      { id: "disease", label: "Disease", title: "Mitral regurgitation", body: "When the leaflets do not close completely, blood can leak back into the left atrium during contraction.", cue: "Red highlights the valve being discussed." },
      { id: "postop", label: "Expected repair", title: "After valve repair", body: "The surgeon may repair leaflets or chordae and add an annuloplasty ring, aiming to reduce leakage while preserving the valve.", cue: "Green represents the treatment goal, not a guarantee of individual outcome." },
    ],
    tabs: ["Before surgery", "Recovery", "Teach-back"],
    preop: [
      { title: "Understand the problem", body: "Identify the affected valve, direction of leakage, and its effect on heart function." },
      { title: "Understand the operation", body: "The repair method depends on testing and findings during surgery." },
      { title: "Compare options", body: "Discuss repair, replacement, observation, and their benefits, risks, and limits." },
      { title: "Prepare", body: "Follow instructions for testing, medicines, fasting, and skin preparation." },
      { title: "After surgery", body: "Most patients first receive close monitoring before returning to the ward." },
    ],
    recoveryTitle: "Recovery checklist", recoveryNote: "General education only; follow the instructions from your own care team.",
    recovery: ["Practice breathing, supported coughing, and early movement", "Keep the incision clean and watch for redness or drainage", "Take medicines as prescribed; do not stop anticoagulants on your own", "Track temperature, weight, breathlessness, and swelling", "Attend follow-up with discharge papers and a medicine list"],
    warningTitle: "Contact the care team promptly", warnings: ["Chest pain, marked breathlessness, or confusion", "Persistent fever, wound drainage, or bleeding", "Palpitations with dizziness or fainting", "Rapid weight gain or worsening leg swelling"],
    teachTitle: "Ask the patient to explain in their own words", teachIntro: "This checks whether the explanation was clear; it is not a test of the patient.",
    questions: ["Which part of your heart is the operation intended to repair?", "Which warning signs mean you should contact the hospital?", "What will you do if medicine or activity instructions are unclear?"],
    understood: "Understood", revisit: "Explain again", summary: "Education progress", complete: "Complete education", completed: "Complete — clinician can review key points", previous: "Previous", next: "Next",
    disclaimer: "This page supports communication and does not replace diagnosis, individualized advice, or formal informed consent.",
  },
} as const;

function ClinicalHeart3D({ state, playing, phase, locale }: { state: ClinicalHeartState; playing: boolean; phase: "filling" | "pumping"; locale: string }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<AnatomyViewer | null>(null);
  const [loading, setLoading] = useState(true);
  const heart = organStructures.find((organ) => organ.id === "heart")!;
  const internal = heart.internalView!;

  useEffect(() => {
    if (!mountRef.current) return;
    const viewer = new AnatomyViewer(mountRef.current, {
      onLoading: (active) => setLoading(active),
      onSelect: () => {},
    });
    viewerRef.current = viewer;
    viewer.setCanvasLabel(locale === "zh" ? "可旋转的三维二尖瓣和血流动画" : "Rotatable 3D mitral valve and blood-flow animation");
    viewer.setAutoRotate(false);
    viewer.setClinicalHeartAnimation(state, playing, phase);
    viewer.setOrgan(internal.model, [], heart.accent).then(() => {
      viewer.showAllStructures();
      internal.structures.forEach((structure) => {
        const opacity = structure.group === "chambers" ? (structure.id === "septum" ? 0.22 : 0.1) : structure.group === "papillary" ? 0.58 : 1;
        viewer.setStructureOpacity(structure.nodeName, opacity);
      });
      viewer.setPresentation(6.35, 0);
      viewer.setClinicalHeartAnimation(state, playing, phase);
      setLoading(false);
    }).catch(() => setLoading(false));
    return () => {
      viewerRef.current = null;
      viewer.dispose();
    };
  // The viewer is long-lived; live animation controls are synchronized below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    viewerRef.current?.setClinicalHeartAnimation(state, playing, phase);
  }, [state, playing, phase]);

  return <div className="clinical-three-stage"><div ref={mountRef} className="clinical-three-mount" />{loading && <div className="clinical-three-loading"><HeartPulse size={34} />{locale === "zh" ? "正在加载三维心脏" : "Loading 3D heart"}</div>}<small>{locale === "zh" ? "拖动旋转 · 滚轮缩放" : "Drag to rotate · scroll to zoom"}</small></div>;
}

export function ClinicalEducation({ locale, modelState, onModelState, onClose }: Props) {
  const copy = locale === "zh" ? content.zh : content.en;
  const [audience, setAudience] = useState<"doctor" | "patient">("doctor");
  const [tab, setTab] = useState(0);
  const [step, setStep] = useState(0);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [answers, setAnswers] = useState<Record<number, "ok" | "again">>({});
  const [complete, setComplete] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [phase, setPhase] = useState<"filling" | "pumping">("filling");
  const currentStage = copy.stages.find((item) => item.id === modelState) ?? copy.stages[0];
  const progress = useMemo(() => Math.round(((checked.size + Object.keys(answers).length) / (copy.recovery.length + copy.questions.length)) * 100), [answers, checked, copy]);
  const animationCopy = locale === "zh"
    ? { play: "播放心动周期", pause: "暂停动画", filling: "舒张期 · 瓣膜开放，血液向前流动", pumping: "收缩期 · 瓣膜关闭", reflux: "可见反流", repaired: "修复后反流减少" }
    : { play: "Play cardiac cycle", pause: "Pause animation", filling: "Diastole · valve open, forward flow", pumping: "Systole · valve closed", reflux: "Regurgitant flow", repaired: "Reduced leakage after repair" };

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setPhase((current) => current === "filling" ? "pumping" : "filling"), 1400);
    return () => window.clearInterval(timer);
  }, [playing]);

  return (
    <div className="clinical-backdrop" role="presentation">
      <section className={`clinical-education ${audience}`} role="dialog" aria-modal="true" aria-labelledby="clinical-title">
        <header className="clinical-header">
          <div><em>{copy.eyebrow}</em><h2 id="clinical-title">{copy.title}</h2><p>{copy.subtitle}</p></div>
          <div className="clinical-header-actions">
            <div className="audience-switch" aria-label="View mode">
              <button type="button" className={audience === "doctor" ? "active" : ""} onClick={() => setAudience("doctor")}><Stethoscope size={15} />{copy.doctor}</button>
              <button type="button" className={audience === "patient" ? "active" : ""} onClick={() => setAudience("patient")}><UserRound size={15} />{copy.patient}</button>
            </div>
            <button type="button" className="clinical-close" onClick={onClose} aria-label={copy.close}><X size={20} /></button>
          </div>
        </header>

        <div className="clinical-privacy"><ShieldAlert size={14} />{copy.privacy}</div>

        <div className="clinical-layout">
          <aside className="clinical-model-card">
            <div className="clinical-state-tabs">
              {copy.stages.map((stage) => <button type="button" key={stage.id} className={modelState === stage.id ? "active" : ""} onClick={() => onModelState(stage.id)}>{stage.label}</button>)}
            </div>
            <div className={`clinical-heart-visual ${modelState} ${playing ? "playing" : "paused"} ${phase}`}>
              <button type="button" className="cycle-toggle" onClick={() => setPlaying((value) => !value)} aria-label={playing ? animationCopy.pause : animationCopy.play}>{playing ? <Pause size={14} /> : <Play size={14} />}</button>
              <div className="cycle-phase" role="status">{phase === "filling" ? animationCopy.filling : `${animationCopy.pumping}${modelState === "disease" ? ` · ${animationCopy.reflux}` : modelState === "postop" ? ` · ${animationCopy.repaired}` : ""}`}</div>
              <ClinicalHeart3D state={modelState} playing={playing} phase={phase} locale={locale} />
              <span>{currentStage.title}</span>
            </div>
            <h3>{currentStage.title}</h3>
            <p>{currentStage.body}</p>
            <small><Activity size={13} />{currentStage.cue}</small>
          </aside>

          <div className="clinical-content">
            <nav className="clinical-tabs" aria-label="Education sections">
              {copy.tabs.map((label, index) => <button type="button" key={label} className={tab === index ? "active" : ""} onClick={() => setTab(index)}>{index === 0 ? <HeartPulse size={15} /> : index === 1 ? <ClipboardCheck size={15} /> : <Users size={15} />}{label}</button>)}
            </nav>

            {tab === 0 && <div className="preop-path">
              <ol>{copy.preop.map((item, index) => <li key={item.title} className={index === step ? "active" : index < step ? "done" : ""}><button type="button" onClick={() => setStep(index)}><span>{index < step ? <Check size={14} /> : index + 1}</span><div><strong>{item.title}</strong>{(audience === "doctor" || index === step) && <p>{item.body}</p>}</div></button></li>)}</ol>
              <div className="step-actions"><button type="button" disabled={step === 0} onClick={() => setStep((value) => value - 1)}><ArrowLeft size={15} />{copy.previous}</button><button type="button" disabled={step === copy.preop.length - 1} onClick={() => setStep((value) => value + 1)}>{copy.next}<ArrowRight size={15} /></button></div>
            </div>}

            {tab === 1 && <div className="recovery-panel"><h3>{copy.recoveryTitle}</h3><p>{copy.recoveryNote}</p><ul className="recovery-checklist">{copy.recovery.map((item, index) => <li key={item}><button type="button" aria-pressed={checked.has(index)} onClick={() => setChecked((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })}><span>{checked.has(index) && <Check size={14} />}</span>{item}</button></li>)}</ul><div className="warning-card"><h4><ShieldAlert size={16} />{copy.warningTitle}</h4><ul>{copy.warnings.map((item) => <li key={item}>{item}</li>)}</ul></div></div>}

            {tab === 2 && <div className="teachback-panel"><h3>{copy.teachTitle}</h3><p>{copy.teachIntro}</p>{copy.questions.map((question, index) => <article key={question}><strong>{index + 1}. {question}</strong><div><button type="button" className={answers[index] === "ok" ? "active ok" : ""} onClick={() => setAnswers((current) => ({ ...current, [index]: "ok" }))}><CheckCircle2 size={15} />{copy.understood}</button><button type="button" className={answers[index] === "again" ? "active again" : ""} onClick={() => setAnswers((current) => ({ ...current, [index]: "again" }))}>{copy.revisit}</button></div></article>)}</div>}
          </div>
        </div>

        <footer className="clinical-footer"><div><span>{copy.summary} · {progress}%</span><div className="clinical-progress"><i style={{ width: `${progress}%` }} /></div><small>{copy.disclaimer}</small></div><button type="button" className={complete ? "complete" : ""} onClick={() => setComplete(true)}>{complete ? <CheckCircle2 size={17} /> : null}{complete ? copy.completed : copy.complete}</button></footer>
      </section>
    </div>
  );
}

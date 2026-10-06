// The interactive wizard (Ink). Screens: welcome → about you → keys → install → done.
import { Box, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import React, { useEffect, useRef, useState } from 'react';
import { runSteps } from './engine.js';
import { appReady, finish, needsAbout, needsKeys, openLaterHint } from './finish.js';
import { STEPS } from './steps.js';
import {
  ANTHROPIC_KEY_URL, GITHUB_TOKEN_URL, REPO_RE, checkAnthropic, checkGitHub, detectState, existingKeys, selectedSteps,
} from './state.js';
import { addSecret, isMac, isWin, mask } from './sys.js';

const ACCENT = 'cyan';

// ---- small pieces -----------------------------------------------------------------------------------

function Header({ step, dryRun }) {
  return (
    <Box marginBottom={1} flexDirection="column">
      <Text>
        <Text bold color={ACCENT}>Bookwyrm setup</Text>
        {step ? <Text dimColor>  ·  {step}</Text> : null}
        {dryRun ? <Text color="yellow">  (dry run: nothing will be changed)</Text> : null}
      </Text>
    </Box>
  );
}

function Select({ items, onSelect, initial = 0 }) {
  const [i, setI] = useState(initial);
  useInput((input, key) => {
    if (key.upArrow || input === 'k') setI((v) => (v + items.length - 1) % items.length);
    else if (key.downArrow || input === 'j' || key.tab) setI((v) => (v + 1) % items.length);
    else if (key.return) onSelect(items[i].value);
    else if (/^[1-9]$/.test(input) && Number(input) <= items.length) onSelect(items[Number(input) - 1].value);
  });
  return (
    <Box flexDirection="column">
      {items.map((item, n) => (
        <Text key={item.value} color={n === i ? ACCENT : undefined}>
          {n === i ? '❯ ' : '  '}{item.label}
        </Text>
      ))}
    </Box>
  );
}

function Field({ label, value, onChange, onSubmit, mask: maskChar, placeholder, error, help }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{label}</Text>
      {help ? <Text dimColor>{help}</Text> : null}
      <Box>
        <Text color={ACCENT}>❯ </Text>
        <TextInput
          value={value}
          onChange={(v) => onChange(v.replace(/[\r\n]/g, ''))}
          onSubmit={onSubmit}
          mask={maskChar}
          placeholder={placeholder}
        />
      </Box>
      {error ? <Text color="yellow">{error}</Text> : null}
    </Box>
  );
}

const Hint = ({ children }) => <Box marginTop={1}><Text dimColor>{children}</Text></Box>;

// ---- welcome ---------------------------------------------------------------------------------------------

function Welcome({ ctx, onNext }) {
  const { exit } = useApp();
  const state = detectState(ctx.profile);
  const allDone = state.every((s) => s.ok);
  useInput((input, key) => {
    if (key.return) onNext();
    else if (key.escape || input === 'q') exit();
  });
  return (
    <Box flexDirection="column">
      <Text>Hello! This sets up <Text bold>Bookwyrm</Text>, the librarian you can call about your knowledge repo.</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>It will install, if they're not here yet:</Text>
        <Text>  • Hermes Agent, which Bookwyrm runs on</Text>
        <Text>  • a small GitHub connector, so Bookwyrm can read the repo and open pull requests</Text>
        <Text>  • the voice service and its speech models (about 1 GB, downloaded once)</Text>
        <Text>  • the Bookwyrm companion app{isMac ? ', in your Applications folder' : isWin ? ', in your Start menu' : ''}</Text>
      </Box>
      <Box marginTop={1}><Text>A first install takes about 10 to 20 minutes, mostly downloading. You can leave it running.</Text></Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>On this computer now</Text>
        {state.map((s) => (
          <Text key={s.label}>
            {s.ok ? <Text color="green">  ✓ </Text> : <Text dimColor>  ○ </Text>}
            {s.label}
            {s.ok ? <Text dimColor>  already done</Text> : s.partial ? <Text dimColor>  partly</Text> : null}
          </Text>
        ))}
      </Box>
      {allDone ? <Hint>Everything is already set up. Running again checks it and picks up any changes.</Hint> : null}
      <Hint>Press Enter to start · Esc to leave</Hint>
    </Box>
  );
}

// ---- about you -------------------------------------------------------------------------------------------

function About({ ctx, onNext }) {
  const a = ctx.answers;
  const [field, setField] = useState(0);
  const [values, setValues] = useState({ name: a.name || '', team: a.team || '', repo: a.repo || '' });
  const [error, setError] = useState('');
  const fields = [
    { key: 'name', label: 'Your name', placeholder: 'Dee Firmin', help: 'How Bookwyrm greets you, and how it credits what you tell it.' },
    { key: 'team', label: 'Your team', placeholder: 'Data Engineering', help: 'Goes with your name on anything Bookwyrm records from you.' },
    { key: 'repo', label: 'Your knowledge repo on GitHub', placeholder: 'owner/name', help: 'The Archivist repo Bookwyrm looks after, written as owner/name.' },
  ];
  const f = fields[field];
  const submit = () => {
    const v = values[f.key].trim();
    if (f.key === 'name' && !v) return setError('Please type your name.');
    if (f.key === 'repo') {
      const repo = v.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
      if (!REPO_RE.test(repo)) return setError('That should look like owner/name, for example dfirmin/archivist-knowledge-01.');
      Object.assign(a, { ...values, repo, name: values.name.trim(), team: values.team.trim() });
      onNext();
      return undefined;
    }
    setError('');
    setValues({ ...values, [f.key]: v });
    setField(field + 1);
    return undefined;
  };
  return (
    <Box flexDirection="column">
      <Text>A little about you, so Bookwyrm knows who it's talking to.</Text>
      {fields.slice(0, field).map((done) => (
        <Text key={done.key}><Text color="green">✓ </Text>{done.label}: <Text bold>{values[done.key] || '—'}</Text></Text>
      ))}
      <Field
        key={f.key}
        label={f.label}
        help={f.help}
        placeholder={f.placeholder}
        value={values[f.key]}
        onChange={(v) => { setError(''); setValues({ ...values, [f.key]: v }); }}
        onSubmit={submit}
        error={error}
      />
      <Hint>Enter to continue</Hint>
    </Box>
  );
}

// ---- keys ------------------------------------------------------------------------------------------------

function KeyStep({ ctx, spec, onDone }) {
  const [phase, setPhase] = useState(spec.existing ? 'choose' : 'enter');
  const [value, setValue] = useState('');
  const [result, setResult] = useState(null);
  const typed = useRef(null);

  const check = async (key, isNew) => {
    typed.current = isNew ? key : null;
    addSecret(key);
    setPhase('checking');
    const r = await spec.check(key);
    setResult(r);
    setPhase(r.ok ? 'ok' : 'failed');
  };

  useEffect(() => {
    if (phase === 'ok') {
      const t = setTimeout(() => onDone(typed.current), 900);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [phase]);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{spec.title}</Text>
      {spec.explain.map((l) => <Text key={l}>{l}</Text>)}
      {phase === 'choose' && (
        <Box flexDirection="column" marginTop={1}>
          <Text>You already have one saved ({mask(spec.existing)}).</Text>
          <Select
            items={[{ label: 'Keep the one I have', value: 'keep' }, { label: 'Enter a new one', value: 'new' }]}
            onSelect={(v) => (v === 'keep' ? check(spec.existing, false) : setPhase('enter'))}
          />
        </Box>
      )}
      {phase === 'enter' && (
        <>
          <Text>Get one at: <Text color={ACCENT}>{spec.url}</Text></Text>
          <Field
            label={`Paste your ${spec.short}`}
            value={value}
            onChange={setValue}
            mask="•"
            onSubmit={() => {
              const v = value.trim();
              if (v) check(v, true);
              else onDone(null);
            }}
          />
          <Hint>Enter to check it · leave it empty to skip for now</Hint>
        </>
      )}
      {phase === 'checking' && (
        <Text><Text color={ACCENT}><Spinner type="dots" /></Text> Checking with {spec.service}…</Text>
      )}
      {phase === 'ok' && <Text color="green">✓ {result.message}</Text>}
      {phase === 'failed' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">! {result.message}</Text>
          <Select
            items={[{ label: 'Try a different one', value: 'again' }, { label: 'Use it anyway and continue', value: 'continue' }]}
            onSelect={(v) => {
              if (v === 'continue') onDone(typed.current);
              else { setValue(''); setPhase('enter'); }
            }}
          />
        </Box>
      )}
    </Box>
  );
}

function Keys({ ctx, onNext }) {
  const have = existingKeys(ctx.profile);
  const [which, setWhich] = useState(0);
  const repo = ctx.answers.repo;
  const specs = [
    {
      title: 'Anthropic API key',
      short: 'Anthropic API key',
      service: 'Anthropic',
      explain: ['Bookwyrm thinks with Claude, through your Anthropic API key. It starts with sk-ant-.'],
      url: ANTHROPIC_KEY_URL,
      existing: have.anthropicKey,
      check: checkAnthropic,
      field: 'anthropicKey',
    },
    {
      title: 'GitHub token',
      short: 'GitHub token',
      service: 'GitHub',
      explain: [
        `A fine-grained token that can reach only ${repo || 'your knowledge repo'}. It's the fence on what Bookwyrm can touch.`,
        'When you make it: Repository access → Only select repositories → the knowledge repo.',
        'Permissions → Contents, Issues and Pull requests: Read and write. Nothing else.',
      ],
      url: GITHUB_TOKEN_URL,
      existing: have.githubToken,
      check: (t) => (repo ? checkGitHub(t, repo) : Promise.resolve({ ok: true, message: 'Not checked (no repo given).' })),
      field: 'githubToken',
    },
  ];
  const spec = specs[which];
  return (
    <Box flexDirection="column">
      <Text>Two keys let Bookwyrm work. They're saved only in Hermes' private settings file on this computer.</Text>
      <Box marginTop={1} flexDirection="column">
        {specs.slice(0, which).map((s) => (
          <Text key={s.field}>
            <Text color="green">✓ </Text>{s.title}: {ctx.answers[s.field] ? 'new one saved' : s.existing ? 'keeping the one you have' : <Text color="yellow">skipped</Text>}
          </Text>
        ))}
      </Box>
      <KeyStep
        key={spec.field}
        ctx={ctx}
        spec={spec}
        onDone={(newValue) => {
          ctx.answers[spec.field] = newValue;
          if (which + 1 < specs.length) setWhich(which + 1);
          else onNext();
        }}
      />
    </Box>
  );
}

// ---- install checklist ---------------------------------------------------------------------------------

const fmtBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

function Bar({ done, total, bytes }) {
  const width = 28;
  if (!total) return <Text dimColor>  {bytes && done ? fmtBytes(done) : ''}</Text>;
  const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)));
  return (
    <Text>
      <Text color={ACCENT}>{'█'.repeat(filled)}</Text>
      <Text dimColor>{'░'.repeat(width - filled)}</Text>
      <Text> {Math.floor((done / total) * 100)}%</Text>
      {bytes ? <Text dimColor>  {fmtBytes(done)} of {fmtBytes(total)}</Text> : null}
    </Text>
  );
}

function StepRow({ step, s, width }) {
  const icon = {
    pending: <Text dimColor>·</Text>,
    running: <Text color={ACCENT}><Spinner type="dots" /></Text>,
    done: <Text color="green">✓</Text>,
    already: <Text color="green">✓</Text>,
    skipped: <Text dimColor>–</Text>,
    warn: <Text color="yellow">!</Text>,
    failed: <Text color="red">✗</Text>,
    plan: <Text color={ACCENT}>→</Text>,
  }[s.status];
  const trim = (t, used = 6) => (t && t.length > width - used ? `${t.slice(0, Math.max(10, width - used - 1))}…` : t);
  const note = {
    already: s.note || 'already done',
    skipped: 'skipped',
    done: s.note,
    warn: s.note,
  }[s.status];
  return (
    <Box flexDirection="column">
      <Text>
        {icon} <Text dimColor={s.status === 'skipped' || s.status === 'pending'}>{step.title}</Text>
        {note && s.status !== 'warn' ? <Text dimColor>  {trim(note, step.title.length + 8)}</Text> : null}
      </Text>
      {s.status === 'failed' && s.error ? <Text color="red">    {trim(s.error.message)}</Text> : null}
      {s.status === 'warn' && <Text color="yellow">    {s.note}</Text>}
      {s.status === 'plan' && s.plan.map((l) => <Text key={l} dimColor>    {l}</Text>)}
      {s.status === 'running' && s.progress && (
        <Text>    <Text dimColor>{s.progress.label} </Text><Bar {...s.progress} /></Text>
      )}
      {s.status === 'running' && !s.progress && s.line ? <Text dimColor>    {trim(s.line)}</Text> : null}
    </Box>
  );
}

function Install({ ctx, onNext }) {
  const { exit } = useApp();
  const rowsRef = useRef(Object.fromEntries(STEPS.map((st) => [st.id, { status: 'pending' }])));
  const [rows, setRows] = useState(rowsRef.current);
  const [failure, setFailure] = useState(null);
  const width = Math.max(40, Math.min(process.stdout.columns || 80, 110));

  useEffect(() => {
    let alive = true;
    runSteps(ctx, {
      update: (id, patch) => {
        rowsRef.current = { ...rowsRef.current, [id]: { ...rowsRef.current[id], ...patch } };
        if (alive) setRows(rowsRef.current);
      },
      onFailure: (step, error) => new Promise((resolve) => setFailure({ step, error, resolve })),
    }).then(({ quit }) => {
      if (!alive) return;
      if (quit) { ctx.quit = true; exit(); } else onNext(rowsRef.current);
    });
    return () => { alive = false; };
  }, []);

  return (
    <Box flexDirection="column">
      <Text>{ctx.opts.dryRun ? 'Here\'s what setup would do. Nothing will be changed.' : 'Setting things up. This is the part you can leave running.'}</Text>
      <Box marginTop={1} flexDirection="column">
        {STEPS.map((step) => <StepRow key={step.id} step={step} s={rows[step.id]} width={width} />)}
      </Box>
      {failure && (
        <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
          <Text color="red" bold>Something went wrong: {failure.step.title}</Text>
          <Text>{failure.error.message}</Text>
          {failure.error.lines.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {failure.error.lines.slice(-8).map((l, n) => <Text key={n} dimColor>{l.length > width - 8 ? `${l.slice(0, width - 9)}…` : l}</Text>)}
            </Box>
          )}
          {failure.error.hint ? <Box marginTop={1}><Text color="yellow">What to try: {failure.error.hint}</Text></Box> : null}
          <Box marginTop={1}>
            <Select
              items={[
                { label: 'Try again', value: 'retry' },
                { label: 'Skip this step for now', value: 'skip' },
                { label: 'Stop setup (you can run it again later)', value: 'quit' },
              ]}
              onSelect={(v) => { const { resolve } = failure; setFailure(null); resolve(v); }}
            />
          </Box>
        </Box>
      )}
    </Box>
  );
}

// ---- done ------------------------------------------------------------------------------------------------

function Done({ ctx, failed }) {
  const { exit } = useApp();
  const ready = !ctx.opts.dryRun && appReady();
  const [q, setQ] = useState(ready && ctx.opts.openAtLogin === undefined ? 'login' : ready && ctx.opts.open === undefined ? 'open' : 'end');
  const answers = useRef({ openAtLogin: ctx.opts.openAtLogin, openNow: ctx.opts.open });
  const [lines, setLines] = useState([]);

  useEffect(() => {
    if (q !== 'end') return undefined;
    ctx.failedCount = failed.length;
    setLines(finish(ctx, answers.current));
    const t = setTimeout(() => exit(), 50);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <Box flexDirection="column">
      {ctx.opts.dryRun
        ? <Text bold>Dry run finished. Nothing was changed.</Text>
        : failed.length
          ? <Text bold color="yellow">Almost there. {failed.length === 1 ? 'One step needs' : `${failed.length} steps need`} attention: {failed.join(', ')}. Run setup again once it's fixed; finished steps are skipped.</Text>
          : <Text bold color="green">Bookwyrm is ready.</Text>}
      {q === 'login' && (
        <Box flexDirection="column" marginTop={1}>
          <Text>Start Bookwyrm when you log in? It sits quietly on the edge of your screen until you click it.</Text>
          <Select items={[{ label: 'Yes', value: true }, { label: 'No', value: false }]} onSelect={(v) => { answers.current.openAtLogin = v; setQ(ctx.opts.open === undefined ? 'open' : 'end'); }} />
        </Box>
      )}
      {q === 'open' && (
        <Box flexDirection="column" marginTop={1}>
          <Text>Open Bookwyrm now?</Text>
          <Select items={[{ label: 'Yes, open it', value: true }, { label: 'Not now', value: false }]} onSelect={(v) => { answers.current.openNow = v; setQ('end'); }} />
        </Box>
      )}
      {q === 'end' && (
        <Box flexDirection="column" marginTop={1}>
          {lines.map((l) => <Text key={l}>{l}</Text>)}
          {ready ? <Text dimColor>{openLaterHint()}</Text> : null}
          {ready && answers.current.openNow ? <Text dimColor>The first call after setup loads the speech models; give it a minute.</Text> : null}
        </Box>
      )}
    </Box>
  );
}

// ---- the wizard ------------------------------------------------------------------------------------------

export function Wizard({ ctx }) {
  const chosen = selectedSteps(ctx.opts);
  const screens = ['welcome', ...(needsAbout(chosen) ? ['about'] : []), ...(needsKeys(chosen) ? ['keys'] : []), 'install', 'done'];
  const [n, setN] = useState(0);
  const [failed, setFailed] = useState([]);
  const screen = screens[n];
  const next = () => setN((v) => v + 1);
  const titles = { welcome: '', about: 'About you', keys: 'Keys', install: ctx.opts.dryRun ? 'Plan' : 'Installing', done: 'Done' };
  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1}>
      <Header step={titles[screen]} dryRun={ctx.opts.dryRun} />
      {screen === 'welcome' && <Welcome ctx={ctx} onNext={next} />}
      {screen === 'about' && <About ctx={ctx} onNext={next} />}
      {screen === 'keys' && <Keys ctx={ctx} onNext={next} />}
      {(screen === 'install' || screen === 'done') && (
        // Stays on screen under Done, so the finished checklist (or the dry-run plan) remains readable.
        <Install ctx={ctx} onNext={(rows) => { setFailed(STEPS.filter((st) => rows[st.id].status === 'failed').map((st) => st.title)); next(); }} />
      )}
      {screen === 'done' && <Box marginTop={1}><Done ctx={ctx} failed={failed} /></Box>}
    </Box>
  );
}

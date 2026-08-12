import { AlertTriangle, Check, Info, Loader2, Stethoscope } from 'lucide-react';
import { useState } from 'react';
import { type AgentHealthCheck, evaluateAgentHealth } from '@/lib/evals/health';
import { sendMcpCommand } from '@/lib/mcp/client';
import { sendAgentContextCommand } from '@/lib/memory/client';
import { sendProviderCommand } from '@/lib/providers/client';
import { sendSkillCommand } from '@/lib/skills/client';

export function AgentHealthCheckPanel() {
  const [checks, setChecks] = useState<AgentHealthCheck[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setRunning(true);
    setError('');
    try {
      const [providers, skills, context, mcp] = await Promise.all([
        sendProviderCommand({ type: 'providers:get' }),
        sendSkillCommand({ type: 'skills:get' }),
        sendAgentContextCommand({ type: 'context:get' }),
        sendMcpCommand({ type: 'mcp:get' }),
      ]);
      setChecks(
        evaluateAgentHealth({
          providers,
          skills,
          context,
          mcp,
          manifest: chrome.runtime.getManifest(),
        }),
      );
    } catch {
      setChecks([]);
      setError('自检未完成，请重新打开设置后再试。');
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="agent-health-settings" aria-label="Agent 运行自检">
      <div className="agent-health-head">
        <div>
          <div className="settings-section-kicker">OBSERVABILITY</div>
          <h2>Agent 运行自检</h2>
          <p>只读取脱敏的本地配置，不调用模型、不访问网页，也不连接 MCP 服务。</p>
        </div>
        <button type="button" disabled={running} onClick={() => void run()}>
          {running ? <Loader2 size={12} className="animate-spin" /> : <Stethoscope size={12} />}
          {running ? '检查中…' : '运行自检'}
        </button>
      </div>
      {checks.length ? (
        <ul className="agent-health-list">
          {checks.map((check) => (
            <li key={check.id} className={`is-${check.status}`}>
              <span className="agent-health-icon">{statusIcon(check.status)}</span>
              <span>
                <strong>{check.label}</strong>
                <small>{check.detail}</small>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <div className="agent-health-error">{error}</div> : null}
    </section>
  );
}

function statusIcon(status: AgentHealthCheck['status']) {
  if (status === 'pass') return <Check size={11} />;
  if (status === 'warning') return <AlertTriangle size={11} />;
  return <Info size={11} />;
}

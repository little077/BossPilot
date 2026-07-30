// ─── 设置页：一期仅保留模型卡包与发卡台 ───

import { ProviderSettings } from './ProviderSettings';

export function SettingsView() {
  return (
    <div className="redscope-settings flex flex-col">
      <ProviderSettings />
    </div>
  );
}

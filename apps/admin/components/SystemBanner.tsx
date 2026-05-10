/**
 * SystemBanner — slot for system-wide operator alerts.
 *
 * Renders nothing in ADR-029 Step 6. The ADR-027 impersonation
 * active-session banner will mount here in the next operator-UI slice.
 * Keeping this component as an explicit slot prevents step-6 layout
 * consumers from needing an update when the banner lands.
 */
export function SystemBanner() {
  return null;
}

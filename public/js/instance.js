// Per-installation browser storage names. Code and build remain identical across instances.
export const instanceProfile=globalThis.__SP_INSTANCE__||{namespace:'sp',experimental:false};
export const instanceKey=name=>`${instanceProfile.namespace}.${name}`;

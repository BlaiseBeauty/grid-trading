import SystemSwitcher    from './SystemSwitcher';
import GodView           from './GodView';
import NotificationDrawer from './NotificationDrawer';

export default function PlatformShell({ children }) {
  return (
    <>
      {/* Fixed top chrome */}
      <SystemSwitcher />
      <GodView />

      {/* Page content — pushed down by shell height via CSS padding-top */}
      <main style={{ minHeight: '100vh' }}>
        {children}
      </main>

      {/* Notification drawer — fixed position, always mounted */}
      <NotificationDrawer />
    </>
  );
}

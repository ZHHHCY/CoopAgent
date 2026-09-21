import "./ChangeIndicator.css";

export function ChangeIndicator({ label }: { label: string }) {
  return <span aria-label={label} className="change-indicator">!</span>;
}

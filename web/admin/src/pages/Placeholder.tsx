export function Placeholder({ title, phase }: { title: string; phase: string }) {
  return (
    <section>
      <h1>{title}</h1>
      <div className="card">
        <p className="muted">This page is built in {phase}.</p>
      </div>
    </section>
  );
}

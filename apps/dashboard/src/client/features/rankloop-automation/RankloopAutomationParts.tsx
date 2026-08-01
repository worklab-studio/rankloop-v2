// The one piece of chrome the Automation card's sections share. It lives here
// rather than in the card so the digest-delivery form can use it without
// importing the card that renders it — the cycle oxlint would reject, and the
// reason a two-component file is worth its own module.

/** An eyebrow over a block of the card, in the app's uppercase-tracking label
 *  style rather than a heading: these are sections of one card, and a page
 *  full of h3s would give them a weight they do not have. */
export function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-base-content/60">
        {title}
      </p>
      {children}
    </div>
  );
}

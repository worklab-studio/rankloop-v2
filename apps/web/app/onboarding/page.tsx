import { PageHeader } from "@/components/ui";
import { Wizard } from "./wizard";

/** /onboarding — the activation moment. The page itself is a server
 * component; all the streaming/step state lives in the client Wizard.
 * Both render fragments so every section sits directly in the layout's
 * gap-5 column. */
export default function OnboardingPage() {
  return (
    <>
      <PageHeader
        title="Add a site"
        subtitle="Point rankloop at a domain. It studies the site, proposes a plan, and asks before it touches anything."
      />
      <Wizard />
    </>
  );
}

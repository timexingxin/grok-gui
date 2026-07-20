export type OnboardingStage = "missing-cli" | "authenticate";

export function nextOnboardingStage(cli: { installed: boolean }): OnboardingStage {
  return cli.installed ? "authenticate" : "missing-cli";
}

# frozen_string_literal: true

cask "grok-gui-lite" do
  version "0.1.0"
  sha256 arm:   "517d05381fb1e3bb9cd1141234e3c97bacb1175028f86630ba8281f704d69e81",
         intel: "d443bcb6e2b15937ec9568395ae27628b32e65165f18d8528864894cfc468136"

  url "https://github.com/timexingxin/grok-gui/releases/download/v#{version}/Grok-GUI-Lite-#{version}-#{arch}.dmg"
  name "Grok GUI Lite"
  desc "Lightweight desktop wrapper for Grok"
  homepage "https://github.com/timexingxin/grok-gui"

  livecheck do
    url :url
    strategy :github_latest_release
  end

  depends_on macos: ">= :big_sur"

  app "Grok GUI Lite.app"

  zap trash: [
    "~/Library/Application Support/com.grok-gui.lite",
    "~/Library/Caches/com.grok-gui.lite",
    "~/Library/Preferences/com.grok-gui.lite.plist",
    "~/Library/Saved Application State/com.grok-gui.lite.savedState",
    "~/Library/WebKit/com.grok-gui.lite",
  ]
end

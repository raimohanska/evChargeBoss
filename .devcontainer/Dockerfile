FROM mcr.microsoft.com/devcontainers/typescript-node:24

# Pre-create the dirs that get named volumes / caches mounted onto them, owned
# by node. Docker creates missing mountpoint parents as root:root, which would
# leave them unwritable for the container user (EACCES on first mkdir).
RUN mkdir -p /home/node/.local/share/opencode /home/node/.config/opencode \
    && chown -R node:node /home/node/.local /home/node/.config

# opencode - baked into the image so rebuilds reuse the layer instead of
# re-downloading. Pinned; bump when you want a newer release.
#
# The installer hardcodes $HOME/.opencode/bin and has no --prefix, so it lands
# in root's home during build; move the binary somewhere both users can reach.
# --no-modify-path stops it rewriting shell rc files we don't keep.
# VERSION must be set on `bash`, not on `curl` - the installer reads it itself.
RUN curl -fsSL https://opencode.ai/install | VERSION=1.18.10 bash -s -- --no-modify-path \
    && mv /root/.opencode/bin/opencode /usr/local/bin/opencode \
    && chmod 755 /usr/local/bin/opencode \
    && rm -rf /root/.opencode

# Trust the bind-mounted workspace at the system level. Doing this here (writes
# /etc/gitconfig) avoids touching the bind-mounted ~/.gitconfig at runtime,
# which fails with "Device or resource busy" - git can't rename-replace a file
# bind mount.
RUN git config --system --add safe.directory /workspaces/evChargeBoss

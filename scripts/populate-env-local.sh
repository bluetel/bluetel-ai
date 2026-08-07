#!/bin/bash
# cspell:ignore nvmfile

# Script to load environment variables from .env.local and execute a command
# Usage: ./populate-env-local.sh <command> [args...]

# Check if .env.local exists
if [ ! -f ".env.local" ]; then
    echo "Warning: .env.local file not found. Proceeding without loading environment variables."
    exec "$@"
    exit $?
fi

# Function to load environment variables from .env.local
load_env() {
    # Read the .env.local file and export variables
    while IFS= read -r line || [ -n "$line" ]; do
        # Skip empty lines and comments
        if [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]]; then
            continue
        fi
        
        # Check if line contains an assignment
        if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
            var_name="${BASH_REMATCH[1]}"
            var_value="${BASH_REMATCH[2]}"
            
            # Remove quotes if present
            var_value=$(echo "$var_value" | sed 's/^"\(.*\)"$/\1/' | sed "s/^'\(.*\)'$/\1/")
            
            # Export the variable
            export "$var_name"="$var_value"
        fi
    done < ".env.local"

    # If NODE_ENV is not set, default to 'development'
    if [ -z "$NODE_ENV" ]; then
        export NODE_ENV="development"
    fi
}

# Function to locate a .nvmrc or .node-version file up the directory tree and activate that Node version via nvm
activate_node_version() {
    local cur nvmfile version
    cur="$PWD"

    while [ "$cur" != "/" ]; do
        if [ -f "$cur/.nvmrc" ]; then
            nvmfile="$cur/.nvmrc"
            break
        fi
        if [ -f "$cur/.node-version" ]; then
            nvmfile="$cur/.node-version"
            break
        fi
        cur=$(dirname "$cur")
    done

    # No nvm file found
    if [ -z "$nvmfile" ]; then
        return 0
    fi

    # Try to source nvm
    if [ -z "$NVM_DIR" ]; then
        NVM_DIR="$HOME/.nvm"
    fi

    if [ -s "$NVM_DIR/nvm.sh" ]; then
        # shellcheck source=/dev/null
        . "$NVM_DIR/nvm.sh"
    elif [ -s "$HOME/.nvm/nvm.sh" ]; then
        # shellcheck source=/dev/null
        . "$HOME/.nvm/nvm.sh"
    fi

    if ! command -v nvm >/dev/null 2>&1; then
        echo "nvm not found; skipping Node version activation from $nvmfile"
        return 0
    fi

    # Read the first non-empty line as the version
    version=$(sed -n '1p' "$nvmfile" | tr -d '[:space:]')
    if [ -z "$version" ]; then
        return 0
    fi

    # Try to use the specified version, install if missing
    if ! nvm use "$version" >/dev/null 2>&1; then
        echo "Installing and using Node $version via nvm..."
        nvm install "$version"
        nvm use "$version"
    else
        echo "Using Node $(node -v) (from $nvmfile)"
    fi
}

# Activate node version if an nvm file exists
activate_node_version

# Check if at least one argument is provided
if [ $# -eq 0 ]; then
    echo "Usage: $0 <command> [args...]"
    echo "Example: $0 payload generate"
    echo "Example: $0 npm run dev"
    exit 1
fi

load_env

# Execute the command with all arguments
exec "$@"

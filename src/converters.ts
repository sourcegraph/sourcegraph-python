/**
 * Converts to/from Sourcegraph client URIs to the URIs known to the language server.
 */
export interface UriConverter {
    toLanguageServer: (clientUri: string) => string
    toClient: (languageServerUri: string) => string
}

export function createUriConverter(
    originalRootUri: string | null,
    actualRootUri: string | null
): UriConverter {
    if (!originalRootUri || !actualRootUri) {
        throw new Error(
            'not yet implemented: null values for originalRootUri and/or actualRootUri'
        )
    }
    return {
        toLanguageServer: clientUri => {
            let path = clientUri
            if (path.startsWith(originalRootUri)) {
                path = path.slice(originalRootUri.length)
                if (path.startsWith('#')) {
                    path = path.slice(1)
                }
                if (!path.startsWith('/')) {
                    path = '/' + path
                }
            }
            return actualRootUri + path
        },
        toClient: languageServerUri => {
            let path = languageServerUri
            if (path.startsWith(actualRootUri)) {
                path = path.slice(actualRootUri.length)
                if (path.startsWith('/')) {
                    path = path.slice(1)
                }
            }
            return originalRootUri + '#' + path
        },
    }
}

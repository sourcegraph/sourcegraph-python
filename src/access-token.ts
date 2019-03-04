import * as sourcegraph from 'sourcegraph'
import gql from 'tagged-template-noop'

interface AccessTokenResponse {
    currentUser: {
        accessTokens: {
            nodes: { note: string }[]
            pageInfo: {
                hasNextPage: boolean
            }
        }
    }
    errors: string[]
}

async function userHasAccessTokenWithNote(note: string): Promise<boolean> {
    const response: AccessTokenResponse = await queryGraphQL(`
    query {
        currentUser {
            accessTokens(first: 1000) {
                nodes {
                    note
                },
                pageInfo {
                    hasNextPage
                }
            }
        }
    }
    `)

    if (
        !response ||
        !response.currentUser ||
        !response.currentUser.accessTokens ||
        !response.currentUser.accessTokens.nodes ||
        !Array.isArray(response.currentUser.accessTokens.nodes)
    ) {
        return false
    }
    if (
        response.currentUser.accessTokens.pageInfo &&
        response.currentUser.accessTokens.pageInfo.hasNextPage
    ) {
        throw new Error('You have too many access tokens (over 1000).')
    }
    return response.currentUser.accessTokens.nodes.some(
        token => token.note === note
    )
}

async function queryGraphQL(query: string, variables: any = {}): Promise<any> {
    const { data, errors } = await sourcegraph.commands.executeCommand(
        'queryGraphQL',
        query,
        variables
    )
    if (errors) {
        throw Object.assign(
            new Error(errors.map((err: any) => err.message).join('\n')),
            { errors }
        )
    }
    return data
}

const NOTE_FOR_PYTHON_ACCESS_TOKEN = 'python'

// Undefined means the current user is anonymous.
let accessTokenPromise: Promise<string | undefined>
export async function getOrTryToCreateAccessToken(): Promise<
    string | undefined
> {
    const hasToken = await userHasAccessTokenWithNote(
        NOTE_FOR_PYTHON_ACCESS_TOKEN
    )
    const setting = sourcegraph.configuration
        .get<Settings>()
        .get('python.accessToken')
    if (hasToken && setting) {
        return setting
    } else {
        return (
            accessTokenPromise ||
            (accessTokenPromise = tryToCreateAccessToken())
        )
    }
}

async function tryToCreateAccessToken(): Promise<string | undefined> {
    const { currentUser } = await queryGraphQL(gql`
        query {
            currentUser {
                id
            }
        }
    `)
    if (!currentUser) {
        return undefined
    } else {
        const currentUserId: string = currentUser.id
        const result = await queryGraphQL(
            gql`
                mutation CreateAccessToken(
                    $user: ID!
                    $scopes: [String!]!
                    $note: String!
                ) {
                    createAccessToken(
                        user: $user
                        scopes: $scopes
                        note: $note
                    ) {
                        id
                        token
                    }
                }
            `,
            {
                user: currentUserId,
                scopes: ['user:all'],
                note: NOTE_FOR_PYTHON_ACCESS_TOKEN,
            }
        )
        const token: string = result.createAccessToken.token
        await sourcegraph.configuration
            .get<Settings>()
            .update('python.accessToken', token)
        return token
    }
}

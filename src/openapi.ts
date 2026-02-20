// Synchronized from docs/openapi.yaml for runtime API docs.
// Update this file when docs/openapi.yaml changes.
export const OPENAPI_YAML = String.raw`
openapi: 3.0.3
info:
  title: WX2Notion API
  version: 0.1.0
  description: |
    API draft for ingesting WeChat shared links, parsing content, and syncing to Notion.
servers:
  - url: /
    description: Current deployment
  - url: https://api.wx2notion.example.com
    description: Production
  - url: https://staging-api.wx2notion.example.com
    description: Staging
tags:
  - name: Ingest
  - name: Item
  - name: Auth
  - name: Settings
  - name: Admin
paths:
  /v1/ingest:
    post:
      tags: [Ingest]
      summary: Ingest a shared item from Android client
      operationId: ingestItem
      security:
        - bearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/IngestRequest'
      responses:
        '202':
          description: Accepted for async processing
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/IngestResponse'
        '400':
          $ref: '#/components/responses/BadRequest'
        '401':
          $ref: '#/components/responses/Unauthorized'
  /v1/items:
    get:
      tags: [Item]
      summary: List items in inbox
      operationId: listItems
      security:
        - bearerAuth: []
      parameters:
        - in: query
          name: status
          schema:
            $ref: '#/components/schemas/ItemStatus'
        - in: query
          name: page_size
          schema:
            type: integer
            minimum: 1
            maximum: 100
            default: 20
        - in: query
          name: page_token
          schema:
            type: string
      responses:
        '200':
          description: Item list
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ItemListResponse'
        '401':
          $ref: '#/components/responses/Unauthorized'
  /v1/items/{itemId}:
    get:
      tags: [Item]
      summary: Get a single item
      operationId: getItem
      security:
        - bearerAuth: []
      parameters:
        - in: path
          name: itemId
          required: true
          schema:
            type: string
            format: uuid
      responses:
        '200':
          description: Item details
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ItemResponse'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '404':
          $ref: '#/components/responses/NotFound'
  /v1/items/{itemId}/retry:
    post:
      tags: [Item]
      summary: Retry parse/sync for a failed item
      operationId: retryItem
      security:
        - bearerAuth: []
      parameters:
        - in: path
          name: itemId
          required: true
          schema:
            type: string
            format: uuid
      responses:
        '202':
          description: Retry accepted
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/RetryResponse'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '404':
          $ref: '#/components/responses/NotFound'
  /v1/auth/notion/start:
    get:
      tags: [Auth]
      summary: Build Notion OAuth authorize URL
      operationId: startNotionAuth
      security:
        - bearerAuth: []
      responses:
        '200':
          description: OAuth start payload
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AuthStartResponse'
        '401':
          $ref: '#/components/responses/Unauthorized'
  /v1/auth/notion/callback:
    get:
      tags: [Auth]
      summary: OAuth callback endpoint
      operationId: notionAuthCallback
      parameters:
        - in: query
          name: code
          required: true
          schema:
            type: string
        - in: query
          name: state
          required: true
          schema:
            type: string
      responses:
        '200':
          description: Callback processed
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AuthCallbackResponse'
        '400':
          $ref: '#/components/responses/BadRequest'
  /v1/settings/notion-target:
    put:
      tags: [Settings]
      summary: Set target Notion database id for current user
      operationId: updateNotionTarget
      security:
        - bearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/UpdateNotionTargetRequest'
      responses:
        '200':
          description: Updated
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/UpdateNotionTargetResponse'
        '400':
          $ref: '#/components/responses/BadRequest'
        '401':
          $ref: '#/components/responses/Unauthorized'
  /v1/admin/tokens:
    post:
      tags: [Admin]
      summary: Create a new API access token
      operationId: createAdminToken
      security:
        - bearerAuth: []
      requestBody:
        required: false
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/AdminCreateTokenRequest'
      responses:
        '201':
          description: Token created
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AdminCreateTokenResponse'
        '400':
          $ref: '#/components/responses/BadRequest'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '403':
          $ref: '#/components/responses/Forbidden'
    get:
      tags: [Admin]
      summary: List API access tokens
      operationId: listAdminTokens
      security:
        - bearerAuth: []
      parameters:
        - in: query
          name: user_id
          schema:
            type: string
        - in: query
          name: active
          schema:
            type: boolean
      responses:
        '200':
          description: Token list
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AdminTokenListResponse'
        '400':
          $ref: '#/components/responses/BadRequest'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '403':
          $ref: '#/components/responses/Forbidden'
  /v1/admin/tokens/{tokenId}/revoke:
    post:
      tags: [Admin]
      summary: Revoke an API access token
      operationId: revokeAdminToken
      security:
        - bearerAuth: []
      parameters:
        - in: path
          name: tokenId
          required: true
          schema:
            type: string
      responses:
        '200':
          description: Token revoked
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AdminRevokeTokenResponse'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '403':
          $ref: '#/components/responses/Forbidden'
        '404':
          $ref: '#/components/responses/NotFound'
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
  responses:
    BadRequest:
      description: Invalid request
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ErrorResponse'
    Unauthorized:
      description: Missing or invalid auth token
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ErrorResponse'
    NotFound:
      description: Resource not found
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ErrorResponse'
    Forbidden:
      description: Permission denied
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ErrorResponse'
  schemas:
    IngestRequest:
      type: object
      required:
        - client_item_id
        - source_url
      properties:
        client_item_id:
          type: string
          description: Stable client-side id for deduplication.
        source_url:
          type: string
          format: uri
        raw_text:
          type: string
          description: Full shared text payload from Android intent.
        source_app:
          type: string
          default: wechat
        source_type:
          type: string
          enum: [wechat_mp]
          default: wechat_mp
    IngestResponse:
      type: object
      required:
        - item_id
        - status
      properties:
        item_id:
          type: string
          format: uuid
        status:
          $ref: '#/components/schemas/ItemStatus'
        duplicated_from_item_id:
          type: string
          format: uuid
          nullable: true
    ItemListResponse:
      type: object
      required:
        - items
        - next_page_token
      properties:
        items:
          type: array
          items:
            $ref: '#/components/schemas/Item'
        next_page_token:
          type: string
          nullable: true
    ItemResponse:
      type: object
      required:
        - item
      properties:
        item:
          $ref: '#/components/schemas/Item'
    Item:
      type: object
      required:
        - id
        - source_url
        - status
        - created_at
        - updated_at
      properties:
        id:
          type: string
          format: uuid
        source_url:
          type: string
          format: uri
        normalized_url:
          type: string
          format: uri
        source_type:
          type: string
          enum: [wechat_mp]
        title:
          type: string
          nullable: true
        summary:
          type: string
          nullable: true
        cover_url:
          type: string
          format: uri
          nullable: true
        content_plaintext:
          type: string
          nullable: true
        status:
          $ref: '#/components/schemas/ItemStatus'
        notion_page_id:
          type: string
          nullable: true
        notion_page_url:
          type: string
          format: uri
          nullable: true
        error:
          $ref: '#/components/schemas/SyncError'
        created_at:
          type: string
          format: date-time
        updated_at:
          type: string
          format: date-time
    RetryResponse:
      type: object
      required:
        - item_id
        - status
      properties:
        item_id:
          type: string
          format: uuid
        status:
          $ref: '#/components/schemas/ItemStatus'
    AuthStartResponse:
      type: object
      required:
        - authorize_url
        - state
      properties:
        authorize_url:
          type: string
          format: uri
        state:
          type: string
        expires_at:
          type: string
          format: date-time
    AuthCallbackResponse:
      type: object
      required:
        - success
      properties:
        success:
          type: boolean
        deep_link:
          type: string
          format: uri
          nullable: true
        workspace_name:
          type: string
          nullable: true
    UpdateNotionTargetRequest:
      type: object
      required:
        - database_id
      properties:
        database_id:
          type: string
        database_title:
          type: string
          nullable: true
    UpdateNotionTargetResponse:
      type: object
      required:
        - database_id
      properties:
        database_id:
          type: string
        database_title:
          type: string
          nullable: true
    AdminCreateTokenRequest:
      type: object
      properties:
        user_id:
          type: string
        label:
          type: string
          nullable: true
        scopes:
          oneOf:
            - type: array
              items:
                type: string
            - type: string
          nullable: true
        expires_at:
          type: string
          format: date-time
          nullable: true
    AdminCreateTokenResponse:
      type: object
      required:
        - token
        - token_record
      properties:
        token:
          type: string
          description: Plain token shown only once at creation time.
        token_record:
          $ref: '#/components/schemas/AdminTokenRecord'
    AdminTokenListResponse:
      type: object
      required:
        - tokens
      properties:
        tokens:
          type: array
          items:
            $ref: '#/components/schemas/AdminTokenRecord'
    AdminRevokeTokenResponse:
      type: object
      required:
        - token_id
        - status
      properties:
        token_id:
          type: string
        status:
          type: string
          enum: [REVOKED]
    AdminTokenRecord:
      type: object
      required:
        - id
        - user_id
        - scopes
        - is_active
        - created_at
        - updated_at
      properties:
        id:
          type: string
        user_id:
          type: string
        label:
          type: string
          nullable: true
        scopes:
          type: array
          items:
            type: string
        is_active:
          type: boolean
        expires_at:
          type: string
          format: date-time
          nullable: true
        last_used_at:
          type: string
          format: date-time
          nullable: true
        created_at:
          type: string
          format: date-time
        updated_at:
          type: string
          format: date-time
    SyncError:
      type: object
      nullable: true
      properties:
        code:
          type: string
          nullable: true
        message:
          type: string
          nullable: true
        retriable:
          type: boolean
          nullable: true
        trace_id:
          type: string
          nullable: true
    ErrorResponse:
      type: object
      required:
        - error
      properties:
        error:
          type: object
          required:
            - code
            - message
          properties:
            code:
              type: string
            message:
              type: string
            trace_id:
              type: string
              nullable: true
    ItemStatus:
      type: string
      enum:
        - RECEIVED
        - PARSING
        - PARSE_FAILED
        - SYNCING
        - SYNC_FAILED
        - SYNCED
`;

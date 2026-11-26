# Trishbha API (Node.js + Express + MongoDB)

Backend starter for the Trishbha 3D-printing marketplace.

## Included
- JWT registration, login and current-user endpoint (bcrypt password hashing)
- Product catalogue read endpoint and admin-only product creation
- Authenticated 3D model upload endpoint (STL, OBJ, 3MF, STEP/STP; size limit configurable)
- Indicative quote requests saved in MongoDB
- Customer order creation and Razorpay order/payment-signature verification
- Helmet security headers, CORS allow-list and API rate limiting

## Run locally
1. Install Node.js 20+ and MongoDB.
2. From this folder run `npm install`.
3. Copy `.env.example` to `.env` and set a long random `JWT_SECRET`, MongoDB URI and frontend origin.
4. Run `npm run dev` (or `npm start`).
5. Check `GET http://localhost:5000/api/health`.

## Main endpoints
| Method | Endpoint | Auth |
|---|---|---|
| GET | /api/health | No |
| POST | /api/auth/register | No |
| POST | /api/auth/login | No |
| GET | /api/auth/me | Yes |
| GET | /api/products | No |
| POST | /api/products | Admin |
| POST | /api/uploads/model | Yes, multipart field: model |
| POST | /api/quotes | Yes |
| GET | /api/quotes/mine | Yes |
| POST | /api/orders/checkout | Yes, Razorpay configured |
| POST | /api/payments/verify | Yes |
| GET | /api/orders/mine | Yes |

## Important production work still required
- Set secrets in the hosting provider's environment settings. Never commit `.env`.
- Create the first admin user through a controlled seed/admin process; public registration always creates customer accounts.
- Move uploads from local disk to private object storage (e.g. S3-compatible storage), add malware scanning, ownership checks and retention/deletion policies.
- Add real 3D geometry parsing, mesh repair, dimensions/volume extraction and slicer integration. The quote endpoint currently uses declared weight and print-time inputs; it is not an automatic slicer.
- Add Razorpay live/test credentials and configure webhook signature verification before accepting real payments. Do not expose the secret key in frontend code.
- Add inventory reservation, idempotency, tax/shipping, refunds, order-state audit logs, email notifications and automated tests.
- Configure HTTPS, production CORS origins, backups, monitoring and deployment for the API + MongoDB. GitHub Pages hosts only the static frontend; it does not run this Node server.

## Frontend integration
The existing GitHub Pages site is a static frontend preview. Configure its API base URL (for example, `https://api.your-domain.example`) and wire its forms/cart to these endpoints after the API is deployed. Do not use localhost in the published frontend.
